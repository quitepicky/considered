package considered

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type errProvider struct{}

func (errProvider) Name() string { return "err" }

func (errProvider) WithExcludes(ExcludeRuntime) Provider { return errProvider{} }

func (errProvider) Collect(context.Context, string) ([]MetricRecord, error) {
	return nil, errors.New("boom")
}

func TestFilesystemProviderCollectsBytesAndLongestLine(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("short\nlonger\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".git", "ignored"), []byte("very very long"), 0644); err != nil {
		t.Fatal(err)
	}
	records, err := (FilesystemProvider{}).Collect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("expected one record, got %#v", records)
	}
	values := records[0].Values
	if values["filesystem.bytes"] != 13 || values["filesystem.longest_line"] != 6 {
		t.Fatalf("unexpected values: %#v", values)
	}
}

func TestFilesystemProviderRespectsGitignore(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("ignored.txt\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "kept.txt"), []byte("hi\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ignored.txt"), []byte("nope\n"), 0644); err != nil {
		t.Fatal(err)
	}
	records, err := (FilesystemProvider{}).Collect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records {
		if record.Subject == "ignored.txt" {
			t.Fatalf("gitignored file should be skipped: %#v", records)
		}
	}
}

func TestFilesystemProviderScopesToRequestedMetrics(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello\n"), 0644); err != nil {
		t.Fatal(err)
	}
	records, err := FilesystemProvider{Metrics: map[string]bool{"filesystem.bytes": true}}.Collect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("expected one record, got %#v", records)
	}
	values := records[0].Values
	if _, ok := values["filesystem.longest_line"]; ok {
		t.Fatalf("longest_line should not be collected when unrequested: %#v", values)
	}
	if values["filesystem.bytes"] != 6 {
		t.Fatalf("unexpected bytes: %#v", values)
	}
}

func TestFilesystemProviderCountsRunesNotBytes(t *testing.T) {
	dir := t.TempDir()
	// "héllo" is 5 runes but 6 bytes (é is two bytes in UTF-8).
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("héllo\n"), 0644); err != nil {
		t.Fatal(err)
	}
	records, err := (FilesystemProvider{}).Collect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if records[0].Values["filesystem.longest_line"] != 5 {
		t.Fatalf("expected 5 runes, got %#v", records[0].Values)
	}
}

func TestExternalProviderReportsMissingBinary(t *testing.T) {
	_, err := (ExternalProvider{ProviderName: "ghost", Command: "considered-ghost-does-not-exist"}).Collect(context.Background(), t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected not-found error, got %v", err)
	}
}

func TestExternalProviderCollectsProviderOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "provider")
	body := "#!/bin/sh\nprintf '%s' '{\"metrics\":[{\"subject\":\"a.go\",\"values\":{\"custom.value\":3}}]}'\n"
	if err := os.WriteFile(script, []byte(body), 0755); err != nil {
		t.Fatal(err)
	}
	records, err := (ExternalProvider{ProviderName: "custom", Command: script}).Collect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if records[0].Provider != "custom" || records[0].Values["custom.value"] != 3 {
		t.Fatalf("unexpected records: %#v", records)
	}
}

func TestExternalProviderReportsInvalidJSON(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script test")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "provider")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf nope\n"), 0755); err != nil {
		t.Fatal(err)
	}
	_, err := (ExternalProvider{ProviderName: "custom", Command: script}).Collect(context.Background(), dir)
	if err == nil || !strings.Contains(err.Error(), "invalid JSON") {
		t.Fatalf("expected invalid JSON error, got %v", err)
	}
}

func TestProvidersForStandards(t *testing.T) {
	providers := ProvidersForStandards(map[string]Boundary{
		"scc.code_lines":       {Max: Float64(1)},
		"filesystem.bytes":     {Max: Float64(1)},
		"eslint.warning_count": {Max: Float64(1)},
	})
	names := []string{providers[0].Name(), providers[1].Name(), providers[2].Name()}
	if strings.Join(names, ",") != "eslint,filesystem,scc" {
		t.Fatalf("unexpected provider ordering: %v", names)
	}
}

func TestSubjectPathRejectsOutsidePath(t *testing.T) {
	if _, err := SubjectPath("/tmp/root", "/tmp/elsewhere/file"); err == nil {
		t.Fatal("expected outside root error")
	}
}

func TestSubjectPathAllowsDotDotPrefixedName(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "..cache", "data.txt")

	got, err := SubjectPath(root, path)
	if err != nil {
		t.Fatalf("SubjectPath returned an error for an in-root path: %v", err)
	}
	want := filepath.ToSlash(filepath.Join("..cache", "data.txt"))
	if got != want {
		t.Fatalf("SubjectPath = %q, want %q", got, want)
	}
}

func TestCollectAllHandlesEmptyAndProviderErrors(t *testing.T) {
	records, err := CollectAll(context.Background(), t.TempDir(), nil)
	if err != nil || records != nil {
		t.Fatalf("expected empty collection, got records=%#v err=%v", records, err)
	}
	if _, err := CollectAll(context.Background(), t.TempDir(), []Provider{errProvider{}}); err == nil {
		t.Fatal("expected provider error")
	}
}
