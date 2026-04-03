package tmux

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

type Runner interface {
	Run(ctx context.Context, args ...string) (string, error)
}

type Client struct {
	runner Runner
}

type Options struct {
	SocketPath string
	ServerName string
}

type execRunner struct {
	prefixArgs []string
}

type Tree struct {
	Sessions []Session `json:"sessions"`
}

type Session struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Windows []Window `json:"windows"`
}

type Window struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Index     int    `json:"index"`
	Active    bool   `json:"active"`
	PaneCount int    `json:"paneCount"`
	Target    string `json:"target"`
	Session   string `json:"session"`
	Panes     []Pane `json:"panes"`
}

type Pane struct {
	ID       string `json:"id"`
	Index    int    `json:"index"`
	Title    string `json:"title"`
	Active   bool   `json:"active"`
	Target   string `json:"target"`
	WindowID string `json:"windowId"`
	Left     int    `json:"left"`
	Top      int    `json:"top"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

type Snapshot struct {
	Target    string         `json:"target"`
	Label     string         `json:"label"`
	WindowID  string         `json:"windowId"`
	Timestamp int64          `json:"timestamp"`
	Panes     []PaneSnapshot `json:"panes"`
}

type PaneSnapshot struct {
	PaneID  string   `json:"paneId"`
	Title   string   `json:"title"`
	Active  bool     `json:"active"`
	Left    int      `json:"left"`
	Top     int      `json:"top"`
	Width   int      `json:"width"`
	Height  int      `json:"height"`
	CursorX int      `json:"cursorX"`
	CursorY int      `json:"cursorY"`
	Lines   []string `json:"lines"`
	Target  string   `json:"target"`
}

func NewClient(opts Options) *Client {
	return &Client{runner: newExecRunner(opts)}
}

func NewClientWithRunner(r Runner) *Client {
	return &Client{runner: r}
}

func CheckAvailable(opts Options) error {
	args := append(buildPrefixArgs(opts), "-V")
	cmd := exec.Command("tmux", args...)
	if err := cmd.Run(); err != nil {
		return err
	}
	return nil
}

func (c *Client) Close() error {
	if closer, ok := c.runner.(interface{ Close() error }); ok {
		return closer.Close()
	}
	return nil
}

func newExecRunner(opts Options) execRunner {
	return execRunner{prefixArgs: buildPrefixArgs(opts)}
}

func buildPrefixArgs(opts Options) []string {
	args := make([]string, 0, 4)
	if opts.ServerName != "" {
		args = append(args, "-L", opts.ServerName)
	}
	if opts.SocketPath != "" {
		args = append(args, "-S", opts.SocketPath)
	}
	return args
}

func (r execRunner) Run(ctx context.Context, args ...string) (string, error) {
	fullArgs := append(append([]string{}, r.prefixArgs...), args...)
	cmd := exec.CommandContext(ctx, "tmux", fullArgs...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func (c *Client) Tree(ctx context.Context) (*Tree, error) {
	sessionsOut, err := c.runner.Run(ctx, "list-sessions", "-F", "#{session_id}\t#{session_name}")
	if err != nil {
		return nil, err
	}
	sessionRows := parseTSV(strings.TrimSpace(sessionsOut), 2)
	if len(sessionRows) == 0 {
		return nil, errors.New("no tmux sessions found")
	}

	windowsOut, err := c.runner.Run(ctx, "list-windows", "-a", "-F", "#{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{session_name}:#{window_index}")
	if err != nil {
		return nil, err
	}
	panesOut, err := c.runner.Run(ctx, "list-panes", "-a", "-F", "#{window_id}\t#{pane_id}\t#{pane_index}\t#{pane_title}\t#{pane_active}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}")
	if err != nil {
		return nil, err
	}

	windowsBySession := make(map[string][]Window)
	for _, row := range parseTSV(strings.TrimSpace(windowsOut), 7) {
		idx, _ := strconv.Atoi(row[2])
		paneCount, _ := strconv.Atoi(row[5])
		windowsBySession[row[0]] = append(windowsBySession[row[0]], Window{
			ID:        row[1],
			Index:     idx,
			Name:      row[3],
			Active:    row[4] == "1",
			PaneCount: paneCount,
			Target:    row[6],
			Session:   row[0],
		})
	}

	panesByWindow := make(map[string][]Pane)
	for _, row := range parseTSV(strings.TrimSpace(panesOut), 10) {
		idx, _ := strconv.Atoi(row[2])
		left, _ := strconv.Atoi(row[6])
		top, _ := strconv.Atoi(row[7])
		width, _ := strconv.Atoi(row[8])
		height, _ := strconv.Atoi(row[9])
		panesByWindow[row[0]] = append(panesByWindow[row[0]], Pane{
			ID:       row[1],
			Index:    idx,
			Title:    row[3],
			Active:   row[4] == "1",
			Target:   row[5],
			WindowID: row[0],
			Left:     left,
			Top:      top,
			Width:    width,
			Height:   height,
		})
	}

	tree := &Tree{}
	for _, row := range sessionRows {
		windows := windowsBySession[row[0]]
		sort.Slice(windows, func(i, j int) bool { return windows[i].Index < windows[j].Index })
		for i := range windows {
			panes := panesByWindow[windows[i].ID]
			sort.Slice(panes, func(a, b int) bool { return panes[a].Index < panes[b].Index })
			windows[i].Panes = panes
		}
		tree.Sessions = append(tree.Sessions, Session{
			ID:      row[0],
			Name:    row[1],
			Windows: windows,
		})
	}
	return tree, nil
}

func (t *Tree) FirstPaneTarget() (string, error) {
	for _, s := range t.Sessions {
		for _, w := range s.Windows {
			for _, p := range w.Panes {
				return p.Target, nil
			}
		}
	}
	return "", errors.New("no tmux panes found")
}

func (c *Client) Snapshot(ctx context.Context, target string) (*Snapshot, error) {
	tree, err := c.Tree(ctx)
	if err != nil {
		return nil, err
	}
	return c.SnapshotWithTree(ctx, tree, target)
}

func (c *Client) SnapshotWithTree(ctx context.Context, tree *Tree, target string) (*Snapshot, error) {
	for _, session := range tree.Sessions {
		for _, window := range session.Windows {
			if window.Target == target {
				return c.snapshotWindow(ctx, window)
			}
			for _, pane := range window.Panes {
				if pane.Target == target {
					return c.snapshotPane(ctx, window, pane)
				}
			}
		}
	}
	return nil, fmt.Errorf("tmux target not found: %s", target)
}

func (c *Client) StateKeys(ctx context.Context, tree *Tree) (map[string]string, error) {
	out, err := c.runner.Run(ctx, "list-panes", "-a", "-F", "#{session_name}:#{window_index}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{history_size}\t#{pane_title}\t#{pane_active}")
	if err != nil {
		return nil, err
	}
	rows := parseTSV(strings.TrimSpace(out), 11)
	paneKeys := make(map[string]string, len(rows))
	windowKeys := make(map[string][]string)
	for _, row := range rows {
		key := strings.Join(row[2:], "\t")
		windowTarget := row[0]
		paneTarget := row[1]
		paneKeys[paneTarget] = key
		windowKeys[windowTarget] = append(windowKeys[windowTarget], paneTarget+"="+key)
	}
	keys := make(map[string]string)
	for _, session := range tree.Sessions {
		for _, window := range session.Windows {
			keys[window.Target] = strings.Join(windowKeys[window.Target], "|")
			for _, pane := range window.Panes {
				keys[pane.Target] = paneKeys[pane.Target]
			}
		}
	}
	return keys, nil
}

func (c *Client) snapshotWindow(ctx context.Context, window Window) (*Snapshot, error) {
	snap := &Snapshot{
		Target:   window.Target,
		Label:    window.Name,
		WindowID: window.ID,
	}
	for _, pane := range window.Panes {
		ps, err := c.capturePane(ctx, pane)
		if err != nil {
			return nil, err
		}
		snap.Panes = append(snap.Panes, *ps)
	}
	return snap, nil
}

func (c *Client) snapshotPane(ctx context.Context, window Window, pane Pane) (*Snapshot, error) {
	ps, err := c.capturePane(ctx, pane)
	if err != nil {
		return nil, err
	}
	return &Snapshot{
		Target:   pane.Target,
		Label:    window.Name,
		WindowID: window.ID,
		Panes:    []PaneSnapshot{*ps},
	}, nil
}

func (c *Client) capturePane(ctx context.Context, pane Pane) (*PaneSnapshot, error) {
	sizeOut, err := c.runner.Run(ctx, "display-message", "-p", "-t", pane.Target, "#{cursor_x}\t#{cursor_y}")
	if err != nil {
		return nil, err
	}
	sizeRow := parseTSV(strings.TrimSpace(sizeOut), 2)
	if len(sizeRow) == 0 {
		return nil, errors.New("failed to read pane cursor")
	}
	cursorX, _ := strconv.Atoi(sizeRow[0][0])
	cursorY, _ := strconv.Atoi(sizeRow[0][1])

	out, err := c.runner.Run(ctx, "capture-pane", "-e", "-p", "-t", pane.Target)
	if err != nil {
		return nil, err
	}
	lines := normalizeCaptureLines(out, pane.Height)
	if cursorX < 0 {
		cursorX = 0
	}
	if cursorX >= pane.Width {
		cursorX = max(pane.Width-1, 0)
	}
	if cursorY < 0 {
		cursorY = 0
	}
	if cursorY >= len(lines) {
		cursorY = len(lines) - 1
	}

	return &PaneSnapshot{
		PaneID:  pane.ID,
		Title:   pane.Title,
		Active:  pane.Active,
		Left:    pane.Left,
		Top:     pane.Top,
		Width:   pane.Width,
		Height:  pane.Height,
		CursorX: cursorX,
		CursorY: cursorY,
		Lines:   lines,
		Target:  pane.Target,
	}, nil
}

func normalizeCaptureLines(out string, height int) []string {
	normalized := strings.ReplaceAll(out, "\r", "")
	lines := strings.Split(normalized, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if height > 0 {
		switch {
		case len(lines) < height:
			padding := make([]string, height-len(lines))
			lines = append(lines, padding...)
		case len(lines) > height:
			lines = lines[len(lines)-height:]
		}
	}
	if len(lines) == 0 {
		return make([]string, max(height, 1))
	}
	return lines
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func parseTSV(input string, minCols int) [][]string {
	if strings.TrimSpace(input) == "" {
		return nil
	}
	lines := strings.Split(input, "\n")
	rows := make([][]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < minCols {
			continue
		}
		rows = append(rows, parts)
	}
	return rows
}
