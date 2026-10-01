package considered

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/boyter/gocodewalker"
	"golang.org/x/sync/errgroup"
)

type Provider interface {
	Name() string
	Collect(context.Context, string) ([]MetricRecord, error)
	WithExcludes(ExcludeRuntime) Provider
}

// FilesystemProvider measures raw file properties. It walks the tree the same
// way the scc provider does — honoring .gitignore, .ignore, and submodule
// boundaries — so that filesystem.* and scc.* standards apply to the same set
// of files.
type FilesystemProvider struct {
	// Metrics limits collection to the named filesystem.* metrics. When empty,
	// every filesystem metric is collected.
	Metrics map[string]bool
	Exclude ExcludeRuntime
}

func (FilesystemProvider) Name() string { return "filesystem" }

func (p FilesystemProvider) WithExcludes(excludes ExcludeRuntime) Provider {
	p.Exclude = excludes
	return p
}

func (p FilesystemProvider) wants(metric string) bool {
	return len(p.Metrics) == 0 || p.Metrics[metric]
}

func (p FilesystemProvider) Collect(_ context.Context, root string) ([]MetricRecord, error) {
	needBytes := p.wants("filesystem.bytes")
	needLongest := p.wants("filesystem.longest_line")

	queue := make(chan *gocodewalker.File, 256)
	walker := gocodewalker.NewFileWalker(root, queue)
	walker.IncludeHidden = true
	walker.ExcludeDirectory = excludeDirectoriesWithGit(p.Exclude.Directories)
	// Skip entries we cannot read rather than aborting the whole walk.
	walker.SetErrorHandler(func(error) bool { return true })

	walkErr := make(chan error, 1)
	go func() { walkErr <- walker.Start() }()

	var records []MetricRecord
	for file := range queue {
		record, err := p.measure(root, file.Location, needBytes, needLongest)
		if err != nil {
			// An unreadable file should not fail the entire run.
			continue
		}
		records = append(records, record)
	}
	if err := <-walkErr; err != nil {
		return nil, err
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Subject < records[j].Subject })
	return records, nil
}

func (p FilesystemProvider) measure(root, path string, needBytes, needLongest bool) (MetricRecord, error) {
	subject, err := SubjectPath(root, path)
	if err != nil {
		return MetricRecord{}, err
	}
	values := map[string]float64{}
	if needBytes {
		info, err := os.Stat(path)
		if err != nil {
			return MetricRecord{}, err
		}
		values["filesystem.bytes"] = float64(info.Size())
	}
	if needLongest {
		longest, err := longestLine(path)
		if err != nil {
			return MetricRecord{}, err
		}
		values["filesystem.longest_line"] = float64(longest)
	}
	return MetricRecord{Subject: subject, Provider: "filesystem", Values: values}, nil
}

// longestLine streams the file a line at a time and reports the length of the
// longest line in Unicode characters (not bytes), matching how an editor's
// column ruler counts.
func longestLine(path string) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024*1024)
	longest := 0
	for scanner.Scan() {
		if n := utf8.RuneCount(scanner.Bytes()); n > longest {
			longest = n
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	return longest, nil
}

type ExternalProvider struct {
	ProviderName string
	Command      string
	Exclude      ExcludeRuntime
}

func (p ExternalProvider) Name() string { return p.ProviderName }

func (p ExternalProvider) WithExcludes(excludes ExcludeRuntime) Provider {
	p.Exclude = excludes
	return p
}

func (p ExternalProvider) Collect(ctx context.Context, root string) ([]MetricRecord, error) {
	args := []string{"--root", root, "--json"}
	for _, dir := range p.Exclude.Directories {
		args = append(args, "--exclude-dir", dir)
	}
	cmd := exec.CommandContext(ctx, p.Command, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, fmt.Errorf("%s provider not found: install the %q binary on your PATH", p.ProviderName, p.Command)
		}
		msg := strings.TrimSpace(stderr.String())
		if msg != "" {
			return nil, fmt.Errorf("%s provider failed: %w: %s", p.ProviderName, err, msg)
		}
		return nil, fmt.Errorf("%s provider failed: %w", p.ProviderName, err)
	}
	var payload ProviderOutput
	if err := json.Unmarshal(out, &payload); err != nil {
		return nil, fmt.Errorf("%s provider returned invalid JSON: %w", p.ProviderName, err)
	}
	for i := range payload.Metrics {
		if payload.Metrics[i].Provider == "" {
			payload.Metrics[i].Provider = p.ProviderName
		}
	}
	return payload.Metrics, nil
}

func ProvidersForStandards(standards map[string]Boundary) []Provider {
	seen := map[string]bool{}
	var providers []Provider
	for metric := range standards {
		prefix := Prefix(metric)
		if prefix == "" || seen[prefix] {
			continue
		}
		seen[prefix] = true
		switch prefix {
		case "filesystem":
			providers = append(providers, FilesystemProvider{Metrics: metricsWithPrefix(standards, "filesystem")})
		case "scc":
			providers = append(providers, ExternalProvider{ProviderName: "scc", Command: "considered-scc"})
		default:
			providers = append(providers, ExternalProvider{ProviderName: prefix, Command: "considered-" + prefix})
		}
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i].Name() < providers[j].Name() })
	return providers
}

func metricsWithPrefix(standards map[string]Boundary, prefix string) map[string]bool {
	metrics := map[string]bool{}
	for metric := range standards {
		if Prefix(metric) == prefix {
			metrics[metric] = true
		}
	}
	return metrics
}

func CollectAll(ctx context.Context, root string, providers []Provider) ([]MetricRecord, error) {
	if len(providers) == 0 {
		return nil, nil
	}
	// Providers are independent (each walks the tree or spawns a subprocess),
	// so collect them concurrently.
	collected := make([][]MetricRecord, len(providers))
	group, ctx := errgroup.WithContext(ctx)
	for i, provider := range providers {
		group.Go(func() error {
			records, err := provider.Collect(ctx, root)
			if err != nil {
				return err
			}
			collected[i] = records
			return nil
		})
	}
	if err := group.Wait(); err != nil {
		return nil, err
	}
	var all []MetricRecord
	for _, records := range collected {
		all = append(all, records...)
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].Subject == all[j].Subject {
			return all[i].Provider < all[j].Provider
		}
		return all[i].Subject < all[j].Subject
	})
	return all, nil
}

func ProvidersWithExcludes(providers []Provider, excludes ExcludeRuntime) []Provider {
	withExcludes := make([]Provider, len(providers))
	for i, provider := range providers {
		withExcludes[i] = provider.WithExcludes(excludes)
	}
	return withExcludes
}

func excludeDirectoriesWithGit(directories []string) []string {
	seen := map[string]bool{".git": true}
	result := []string{".git"}
	for _, directory := range directories {
		if directory != "" && !seen[directory] {
			seen[directory] = true
			result = append(result, directory)
		}
	}
	return result
}

func SubjectPath(root, path string) (string, error) {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return "", err
	}
	firstSegment, _, _ := strings.Cut(rel, string(filepath.Separator))
	if firstSegment == ".." {
		return "", errors.New("path is outside root")
	}
	return filepath.ToSlash(rel), nil
}
