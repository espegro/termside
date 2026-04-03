package tmux

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeRunner struct {
	outputs map[string]string
}

func (f fakeRunner) Run(ctx context.Context, args ...string) (string, error) {
	key := ""
	for i, arg := range args {
		if i > 0 {
			key += " "
		}
		key += arg
	}
	out, ok := f.outputs[key]
	if !ok {
		return "", errors.New("missing output")
	}
	return out, nil
}

func TestTreeParsesSessionsWindowsAndPanes(t *testing.T) {
	client := NewClientWithRunner(fakeRunner{
		outputs: map[string]string{
			"list-sessions -F #{session_id}\t#{session_name}": "#S1\tmain\n",
			"list-windows -a -F #{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{session_name}:#{window_index}": "#S1\t@1\t0\teditor\t1\t2\tmain:0\n",
			"list-panes -a -F #{window_id}\t#{pane_id}\t#{pane_index}\t#{pane_title}\t#{pane_active}\t#{session_name}:#{window_index}.#{pane_index}":              "@1\t%1\t0\tvim\t1\tmain:0.0\n@1\t%2\t1\tlogs\t0\tmain:0.1\n",
		},
	})

	tree, err := client.Tree(context.Background())
	if err != nil {
		t.Fatalf("Tree() error = %v", err)
	}
	if len(tree.Sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(tree.Sessions))
	}
	if got := tree.Sessions[0].Windows[0].Panes[1].Target; got != "main:0.1" {
		t.Fatalf("unexpected pane target %q", got)
	}
}

func TestSnapshotForPane(t *testing.T) {
	client := NewClientWithRunner(fakeRunner{
		outputs: map[string]string{
			"list-sessions -F #{session_id}\t#{session_name}": "#S1\tmain\n",
			"list-windows -a -F #{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{session_name}:#{window_index}": "#S1\t@1\t0\teditor\t1\t1\tmain:0\n",
			"list-panes -a -F #{window_id}\t#{pane_id}\t#{pane_index}\t#{pane_title}\t#{pane_active}\t#{session_name}:#{window_index}.#{pane_index}":              "@1\t%1\t0\tvim\t1\tmain:0.0\n",
			"display-message -p -t main:0.0 #{pane_width}\t#{pane_height}\t#{cursor_y}":                                                                           "120\t30\t29\n",
			"capture-pane -e -p -t main:0.0": "line1\nline2\n",
		},
	})

	snap, err := client.Snapshot(context.Background(), "main:0.0")
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}
	if len(snap.Panes) != 1 || snap.Panes[0].Width != 120 {
		t.Fatalf("unexpected snapshot %+v", snap)
	}
	if got := len(snap.Panes[0].Lines); got != 30 {
		t.Fatalf("expected 30 visible lines, got %d", got)
	}
}

func TestBuildPrefixArgs(t *testing.T) {
	args := buildPrefixArgs(Options{
		ServerName: "termside",
		SocketPath: "/tmp/termside.sock",
	})
	if got := strings.Join(args, " "); got != "-L termside -S /tmp/termside.sock" {
		t.Fatalf("unexpected prefix args %q", got)
	}
}
