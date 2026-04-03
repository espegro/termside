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
	key := strings.Join(args, " ")
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
			"list-windows -a -F #{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{session_name}:#{window_index}":                                              "#S1\t@1\t0\teditor\t1\t2\tmain:0\n",
			"list-panes -a -F #{window_id}\t#{pane_id}\t#{pane_index}\t#{pane_title}\t#{pane_active}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}": "@1\t%1\t0\tvim\t1\tmain:0.0\t0\t0\t80\t20\n@1\t%2\t1\tlogs\t0\tmain:0.1\t80\t0\t80\t20\n",
		},
	})

	tree, err := client.Tree(context.Background())
	if err != nil {
		t.Fatalf("Tree() error = %v", err)
	}
	if len(tree.Sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(tree.Sessions))
	}
	pane := tree.Sessions[0].Windows[0].Panes[1]
	if pane.Target != "main:0.1" || pane.Left != 80 || pane.Width != 80 {
		t.Fatalf("unexpected pane %+v", pane)
	}
}

func TestSnapshotForPane(t *testing.T) {
	client := NewClientWithRunner(fakeRunner{
		outputs: map[string]string{
			"list-sessions -F #{session_id}\t#{session_name}": "#S1\tmain\n",
			"list-windows -a -F #{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{session_name}:#{window_index}":                                              "#S1\t@1\t0\teditor\t1\t1\tmain:0\n",
			"list-panes -a -F #{window_id}\t#{pane_id}\t#{pane_index}\t#{pane_title}\t#{pane_active}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}": "@1\t%1\t0\tvim\t1\tmain:0.0\t0\t0\t120\t30\n",
			"display-message -p -t main:0.0 #{cursor_x}\t#{cursor_y}": "7\t29\n",
			"capture-pane -e -p -t main:0.0":                          "line1\nline2\n",
		},
	})

	snap, err := client.Snapshot(context.Background(), "main:0.0")
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}
	if len(snap.Panes) != 1 || snap.Panes[0].Width != 120 {
		t.Fatalf("unexpected snapshot %+v", snap)
	}
	if snap.Panes[0].CursorX != 7 || snap.Panes[0].CursorY != 29 {
		t.Fatalf("unexpected cursor %+v", snap.Panes[0])
	}
	if got := len(snap.Panes[0].Lines); got != 30 {
		t.Fatalf("expected 30 visible lines, got %d", got)
	}
}

func TestStateKeysIncludesWindowAndPaneTargets(t *testing.T) {
	client := NewClientWithRunner(fakeRunner{
		outputs: map[string]string{
			"list-panes -a -F #{session_name}:#{window_index}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{history_size}\t#{pane_title}\t#{pane_active}": "main:0\tmain:0.0\t0\t0\t80\t20\t0\t19\t10\tvim\t1\nmain:0\tmain:0.1\t80\t0\t80\t20\t0\t19\t10\tlogs\t0\n",
		},
	})
	tree := &Tree{
		Sessions: []Session{{
			Name: "main",
			Windows: []Window{{
				Target: "main:0",
				Panes: []Pane{
					{Target: "main:0.0"},
					{Target: "main:0.1"},
				},
			}},
		}},
	}

	keys, err := client.StateKeys(context.Background(), tree)
	if err != nil {
		t.Fatalf("StateKeys() error = %v", err)
	}
	if keys["main:0"] == "" || keys["main:0.0"] == "" || keys["main:0.1"] == "" {
		t.Fatalf("missing keys: %+v", keys)
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
