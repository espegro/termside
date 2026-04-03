package server

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"termside/internal/tmux"
)

//go:embed web/*
var rawWeb embed.FS

const sessionCookie = "termside_session"

type Config struct {
	BindIP          string
	Port            int
	Secret          string
	RefreshInterval time.Duration
	InitialTarget   string
	Tmux            *tmux.Client
}

type App struct {
	cfg             Config
	mux             *http.ServeMux
	templates       *template.Template
	sessions        *sessionStore
	shuttingDown    atomic.Bool
	shutdownMessage atomic.Value
}

type sessionData struct {
	Target     string
	RemoteAddr string
	UserAgent  string
	LastSeen   time.Time
}

type sessionStore struct {
	mu   sync.RWMutex
	data map[string]sessionData
}

type bootstrapData struct {
	APIBase         string `json:"apiBase"`
	RefreshInterval int64  `json:"refreshIntervalMs"`
}

type ClientInfo struct {
	ID         string    `json:"id"`
	RemoteAddr string    `json:"remoteAddr"`
	UserAgent  string    `json:"userAgent"`
	Target     string    `json:"target"`
	LastSeen   time.Time `json:"lastSeen"`
}

func New(cfg Config) (*App, error) {
	if cfg.BindIP == "" {
		return nil, errors.New("bind IP is required")
	}
	if cfg.Secret == "" {
		return nil, errors.New("secret is required")
	}
	if cfg.Tmux == nil {
		return nil, errors.New("tmux client is required")
	}
	webFS, err := fs.Sub(rawWeb, "web")
	if err != nil {
		return nil, err
	}
	tpl, err := template.ParseFS(webFS, "index.html")
	if err != nil {
		return nil, err
	}
	app := &App{
		cfg:       cfg,
		mux:       http.NewServeMux(),
		templates: tpl,
		sessions: &sessionStore{
			data: make(map[string]sessionData),
		},
	}
	app.routes(webFS)
	return app, nil
}

func (a *App) ListenAndServe() (*http.Server, string, error) {
	listenAddr := net.JoinHostPort(a.cfg.BindIP, fmt.Sprintf("%d", a.cfg.Port))
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		return nil, "", err
	}
	actualAddr := ln.Addr().(*net.TCPAddr)
	publicAddr := net.JoinHostPort(a.cfg.BindIP, fmt.Sprintf("%d", actualAddr.Port))
	server := &http.Server{
		Handler:     a.mux,
		ReadTimeout: 10 * time.Second,
	}
	go func() {
		_ = server.Serve(ln)
	}()
	return server, publicAddr, nil
}

func (a *App) Close() error {
	a.sessions.clear()
	return a.cfg.Tmux.Close()
}

func (a *App) BeginShutdown(message string) {
	a.shutdownMessage.Store(message)
	a.shuttingDown.Store(true)
}

func (a *App) routes(webFS fs.FS) {
	a.mux.HandleFunc("/s/", a.handleBootstrap)
	a.mux.HandleFunc("/api/events", a.requireSession(a.handleEvents))
	a.mux.HandleFunc("/api/tree", a.requireSession(a.handleTree))
	a.mux.HandleFunc("/api/view", a.requireSession(a.handleView))
	a.mux.HandleFunc("/api/select", a.requireSession(a.handleSelect))
	a.mux.Handle("/assets/", http.StripPrefix("/assets/", http.FileServer(http.FS(webFS))))
}

func (a *App) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	secret := strings.TrimPrefix(strings.TrimSuffix(r.URL.Path, "/"), "/s/")
	if secret != a.cfg.Secret {
		http.NotFound(w, r)
		return
	}
	sessionID, err := randomHex(16)
	if err != nil {
		http.Error(w, "failed to create session", http.StatusInternalServerError)
		return
	}
	a.sessions.set(sessionID, sessionData{
		Target:     a.cfg.InitialTarget,
		RemoteAddr: remoteHost(r.RemoteAddr),
		UserAgent:  r.UserAgent(),
		LastSeen:   time.Now(),
	})
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    sessionID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})

	payload, err := json.Marshal(bootstrapData{
		APIBase:         "/api",
		RefreshInterval: a.cfg.RefreshInterval.Milliseconds(),
	})
	if err != nil {
		http.Error(w, "failed to render", http.StatusInternalServerError)
		return
	}
	data := struct {
		Bootstrap template.JS
	}{
		Bootstrap: template.JS(payload),
	}
	if err := a.templates.ExecuteTemplate(w, "index.html", data); err != nil {
		http.Error(w, "failed to render", http.StatusInternalServerError)
	}
}

func (a *App) handleTree(w http.ResponseWriter, r *http.Request, sessionID string) {
	tree, err := a.cfg.Tmux.Tree(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, tree)
}

func (a *App) handleView(w http.ResponseWriter, r *http.Request, sessionID string) {
	target := r.URL.Query().Get("target")
	payload, err := a.buildViewPayload(r.Context(), sessionID, target, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (a *App) handleSelect(w http.ResponseWriter, r *http.Request, sessionID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Target string `json:"target"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if req.Target == "" {
		http.Error(w, "target is required", http.StatusBadRequest)
		return
	}
	a.sessions.updateTarget(sessionID, req.Target)
	a.sessions.touch(sessionID, remoteHost(r.RemoteAddr), r.UserAgent())
	writeJSON(w, http.StatusOK, map[string]string{"target": req.Target})
}

func (a *App) handleEvents(w http.ResponseWriter, r *http.Request, sessionID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ticker := time.NewTicker(a.cfg.RefreshInterval)
	defer ticker.Stop()

	treeEvery := 4
	iteration := 0
	var cachedTree *tmux.Tree
	for {
		a.sessions.touch(sessionID, remoteHost(r.RemoteAddr), r.UserAgent())
		if a.shuttingDown.Load() {
			_ = writeSSE(w, "shutdown", map[string]any{
				"message": a.currentShutdownMessage(),
			})
			flusher.Flush()
			return
		}
		includeTree := iteration%treeEvery == 0 || cachedTree == nil
		payload, nextTree, err := a.buildStatePayload(r.Context(), sessionID, includeTree, cachedTree)
		if err != nil {
			_ = writeSSE(w, "error", map[string]any{"message": err.Error()})
		} else {
			cachedTree = nextTree
			_ = writeSSE(w, "state", payload)
		}
		flusher.Flush()
		iteration++

		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}

func (a *App) requireSession(next func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.shuttingDown.Load() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"shutdown": true,
				"message":  a.currentShutdownMessage(),
			})
			return
		}
		cookie, err := r.Cookie(sessionCookie)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if _, ok := a.sessions.get(cookie.Value); !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		a.sessions.touch(cookie.Value, remoteHost(r.RemoteAddr), r.UserAgent())
		next(w, r, cookie.Value)
	}
}

func (a *App) ActiveClients() []ClientInfo {
	return a.sessions.activeSince(5 * time.Second)
}

func (a *App) buildStatePayload(ctx context.Context, sessionID string, includeTree bool, cachedTree *tmux.Tree) (map[string]any, *tmux.Tree, error) {
	tree := cachedTree
	if includeTree || tree == nil {
		var err error
		tree, err = a.cfg.Tmux.Tree(ctx)
		if err != nil {
			return nil, nil, err
		}
	}
	payload, err := a.buildViewPayload(ctx, sessionID, "", tree)
	if err != nil {
		return nil, nil, err
	}
	if includeTree {
		payload["tree"] = tree
	}
	return payload, tree, nil
}

func (a *App) buildViewPayload(ctx context.Context, sessionID, requestedTarget string, cachedTree *tmux.Tree) (map[string]any, error) {
	session, ok := a.sessions.get(sessionID)
	if !ok {
		return nil, errors.New("session missing")
	}
	target := requestedTarget
	if target == "" {
		target = session.Target
	}
	tree := cachedTree
	var err error
	if tree == nil {
		tree, err = a.cfg.Tmux.Tree(ctx)
		if err != nil {
			return nil, err
		}
	}
	snap, err := a.cfg.Tmux.SnapshotWithTree(ctx, tree, target)
	if err != nil {
		fallback, fallbackErr := a.cfg.Tmux.Tree(ctx)
		if fallbackErr != nil {
			return nil, err
		}
		replacement, replacementErr := fallback.FirstPaneTarget()
		if replacementErr != nil {
			return nil, err
		}
		target = replacement
		snap, err = a.cfg.Tmux.SnapshotWithTree(ctx, fallback, target)
		if err != nil {
			return nil, err
		}
		a.sessions.updateTarget(sessionID, target)
		return map[string]any{
			"retargeted": true,
			"snapshot":   snap,
		}, nil
	}
	a.sessions.updateTarget(sessionID, target)
	return map[string]any{
		"snapshot": snap,
	}, nil
}

func (s *sessionStore) get(id string) (sessionData, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	data, ok := s.data[id]
	return data, ok
}

func (s *sessionStore) set(id string, data sessionData) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[id] = data
}

func (s *sessionStore) updateTarget(id, target string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := s.data[id]
	data.Target = target
	s.data[id] = data
}

func (s *sessionStore) touch(id, remoteAddr, userAgent string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, ok := s.data[id]
	if !ok {
		return
	}
	if remoteAddr != "" {
		data.RemoteAddr = remoteAddr
	}
	if userAgent != "" {
		data.UserAgent = userAgent
	}
	data.LastSeen = time.Now()
	s.data[id] = data
}

func (s *sessionStore) clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = make(map[string]sessionData)
}

func (s *sessionStore) activeSince(window time.Duration) []ClientInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cutoff := time.Now().Add(-window)
	clients := make([]ClientInfo, 0, len(s.data))
	for id, data := range s.data {
		if data.LastSeen.Before(cutoff) {
			continue
		}
		clients = append(clients, ClientInfo{
			ID:         id,
			RemoteAddr: data.RemoteAddr,
			UserAgent:  data.UserAgent,
			Target:     data.Target,
			LastSeen:   data.LastSeen,
		})
	}
	return clients
}

func randomHex(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func remoteHost(addr string) string {
	host, err := netip.ParseAddrPort(addr)
	if err == nil {
		return host.Addr().String()
	}
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

func (a *App) currentShutdownMessage() string {
	message, _ := a.shutdownMessage.Load().(string)
	if message == "" {
		return "Connection to the terminal host was closed."
	}
	return message
}

func writeSSE(w http.ResponseWriter, event string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
		return err
	}
	return nil
}
