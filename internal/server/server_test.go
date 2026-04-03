package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"termside/internal/tmux"
)

type fakeTmuxRunner struct {
	outputs map[string]string
}

func (f fakeTmuxRunner) Run(ctx context.Context, args ...string) (string, error) {
	key := strings.Join(args, " ")
	return f.outputs[key], nil
}

func newTestApp(t *testing.T) *App {
	t.Helper()
	client := tmux.NewClientWithRunner(fakeTmuxRunner{
		outputs: map[string]string{
			"list-sessions -F #{session_id}\t#{session_name}": "#S1\tmain\n",
			"list-windows -a -F #{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{session_name}:#{window_index}": "#S1\t@1\t0\teditor\t1\t1\tmain:0\n",
			"list-panes -a -F #{window_id}\t#{pane_id}\t#{pane_index}\t#{pane_title}\t#{pane_active}\t#{session_name}:#{window_index}.#{pane_index}":              "@1\t%1\t0\tvim\t1\tmain:0.0\n",
			"display-message -p -t main:0.0 #{pane_width}\t#{pane_height}\t#{cursor_y}":                                                                           "120\t30\t29\n",
			"capture-pane -e -p -t main:0.0": "line1\n",
		},
	})
	app, err := New(Config{
		BindIP:          "127.0.0.1",
		Secret:          "secret",
		RefreshInterval: 2 * time.Second,
		InitialTarget:   "main:0.0",
		Tmux:            client,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return app
}

func TestUnauthorizedWithoutSession(t *testing.T) {
	app := newTestApp(t)
	req := httptest.NewRequest(http.MethodGet, "/api/tree", nil)
	rec := httptest.NewRecorder()
	app.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestBootstrapSetsCookie(t *testing.T) {
	app := newTestApp(t)
	req := httptest.NewRequest(http.MethodGet, "/s/secret", nil)
	rec := httptest.NewRecorder()
	app.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if cookie := rec.Result().Cookies(); len(cookie) == 0 {
		t.Fatal("expected session cookie")
	}
}

func TestViewReturnsSnapshot(t *testing.T) {
	app := newTestApp(t)
	sessionID := "session"
	app.sessions.set(sessionID, sessionData{Target: "main:0.0"})

	req := httptest.NewRequest(http.MethodGet, "/api/view", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: sessionID})
	rec := httptest.NewRecorder()
	app.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var payload struct {
		Snapshot tmux.Snapshot `json:"snapshot"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error = %v", err)
	}
	if payload.Snapshot.Target != "main:0.0" {
		t.Fatalf("unexpected target %q", payload.Snapshot.Target)
	}
}

func TestViewRetargetsWhenPaneDisappears(t *testing.T) {
	app := newTestApp(t)
	app.cfg.Tmux = tmux.NewClientWithRunner(fakeTmuxRunner{
		outputs: map[string]string{
			"list-sessions -F #{session_id}\t#{session_name}": "#S1\tmain\n",
			"list-windows -a -F #{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{session_name}:#{window_index}": "#S1\t@1\t0\teditor\t1\t1\tmain:0\n",
			"list-panes -a -F #{window_id}\t#{pane_id}\t#{pane_index}\t#{pane_title}\t#{pane_active}\t#{session_name}:#{window_index}.#{pane_index}":              "@1\t%1\t0\tvim\t1\tmain:0.0\n",
			"display-message -p -t main:0.0 #{pane_width}\t#{pane_height}\t#{cursor_y}":                                                                           "120\t30\t29\n",
			"capture-pane -e -p -t main:0.0": "line1\n",
		},
	})
	sessionID := "session"
	app.sessions.set(sessionID, sessionData{Target: "missing:9.9"})

	req := httptest.NewRequest(http.MethodGet, "/api/view", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: sessionID})
	rec := httptest.NewRecorder()
	app.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var payload struct {
		Retargeted bool          `json:"retargeted"`
		Snapshot   tmux.Snapshot `json:"snapshot"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error = %v", err)
	}
	if !payload.Retargeted || payload.Snapshot.Target != "main:0.0" {
		t.Fatalf("unexpected payload %+v", payload)
	}
}

func TestActiveClientsReturnsRecentSessions(t *testing.T) {
	app := newTestApp(t)
	app.sessions.set("fresh", sessionData{
		Target:     "main:0.0",
		RemoteAddr: "192.168.1.20",
		UserAgent:  "iPad",
		LastSeen:   time.Now(),
	})
	app.sessions.set("stale", sessionData{
		Target:   "main:0.1",
		LastSeen: time.Now().Add(-10 * time.Second),
	})

	clients := app.ActiveClients()
	if len(clients) != 1 {
		t.Fatalf("expected 1 active client, got %d", len(clients))
	}
	if clients[0].RemoteAddr != "192.168.1.20" {
		t.Fatalf("unexpected client %+v", clients[0])
	}
}

func TestShutdownRespondsWithMessage(t *testing.T) {
	app := newTestApp(t)
	app.BeginShutdown("Server stopping")
	sessionID := "session"
	app.sessions.set(sessionID, sessionData{Target: "main:0.0"})

	req := httptest.NewRequest(http.MethodGet, "/api/view", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: sessionID})
	rec := httptest.NewRecorder()
	app.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode error = %v", err)
	}
	if payload["message"] != "Server stopping" {
		t.Fatalf("unexpected payload %+v", payload)
	}
}

func TestBuildStatePayloadIncludesTreeAndSnapshot(t *testing.T) {
	app := newTestApp(t)
	app.sessions.set("session", sessionData{Target: "main:0.0"})

	payload, _, err := app.buildStatePayload(context.Background(), "session", true, nil)
	if err != nil {
		t.Fatalf("buildStatePayload() error = %v", err)
	}
	if _, ok := payload["tree"]; !ok {
		t.Fatalf("expected tree in payload: %+v", payload)
	}
	if _, ok := payload["snapshot"]; !ok {
		t.Fatalf("expected snapshot in payload: %+v", payload)
	}
}

func TestSessionTouchRefreshesLastSeen(t *testing.T) {
	app := newTestApp(t)
	before := time.Now().Add(-10 * time.Second)
	app.sessions.set("session", sessionData{
		Target:     "main:0.0",
		RemoteAddr: "192.168.1.20",
		UserAgent:  "iPad",
		LastSeen:   before,
	})

	app.sessions.touch("session", "192.168.1.20", "iPad")
	session, ok := app.sessions.get("session")
	if !ok {
		t.Fatal("expected session to exist")
	}
	if !session.LastSeen.After(before) {
		t.Fatalf("expected LastSeen to be refreshed, got %v <= %v", session.LastSeen, before)
	}
}
