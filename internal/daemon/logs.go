package daemon

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const sseBufferSize = 100

type serviceBuffer struct {
	lines       []LogLine
	subscribers map[int]chan LogLine
	nextID      int
	file        *os.File
}

type LogStreamer struct {
	mu      sync.Mutex
	buffers map[string]*serviceBuffer
}

func NewLogStreamer() *LogStreamer {
	return &LogStreamer{
		buffers: map[string]*serviceBuffer{},
	}
}

func bufferKey(repoID, envID, service string) string {
	return repoID + ":" + envID + ":" + service
}

func (l *LogStreamer) InitService(repoID, envID, service string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, err := l.ensureBufferLocked(repoID, envID, service)
	return err
}

func (l *LogStreamer) AddLine(repoID, envID, service, stream, line string) {
	l.mu.Lock()
	buf, err := l.ensureBufferLocked(repoID, envID, service)
	if err != nil {
		l.mu.Unlock()
		return
	}
	logLine := LogLine{
		TS:      time.Now().UTC().Format(time.RFC3339),
		Service: service,
		Stream:  stream,
		Line:    line,
	}
	buf.lines = append(buf.lines, logLine)
	if len(buf.lines) > sseBufferSize {
		buf.lines = buf.lines[1:]
	}
	payload, _ := json.Marshal(logLine)
	_, _ = buf.file.Write(append(payload, '\n'))

	subs := make([]chan LogLine, 0, len(buf.subscribers))
	for _, ch := range buf.subscribers {
		subs = append(subs, ch)
	}
	l.mu.Unlock()

	for _, ch := range subs {
		select {
		case ch <- logLine:
		default:
		}
	}
}

func (l *LogStreamer) ReadHistory(repoID, envID, service string, lines int) ([]LogLine, error) {
	l.mu.Lock()
	services := l.getServicesForEnvLocked(repoID, envID)
	l.mu.Unlock()

	if service != "" {
		services = []string{service}
	}

	var all []LogLine
	for _, svc := range services {
		file := filepath.Join(RepoLogDir(repoID, envID), svc+".log")
		content, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(strings.NewReader(string(content)))
		var svcLines []LogLine
		for scanner.Scan() {
			var line LogLine
			if err := json.Unmarshal(scanner.Bytes(), &line); err == nil {
				svcLines = append(svcLines, line)
			}
		}
		if len(svcLines) > lines {
			svcLines = svcLines[len(svcLines)-lines:]
		}
		all = append(all, svcLines...)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].TS < all[j].TS })
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	return all, nil
}

func (l *LogStreamer) Subscribe(repoID, envID, service string) (<-chan LogLine, func(), error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	ch := make(chan LogLine, 128)
	keys := []string{}
	subscribe := func(serviceName string) error {
		buf, err := l.ensureBufferLocked(repoID, envID, serviceName)
		if err != nil {
			return err
		}
		id := buf.nextID
		buf.nextID++
		buf.subscribers[id] = ch
		keys = append(keys, bufferKey(repoID, envID, serviceName)+"#"+strconv.Itoa(id))
		return nil
	}

	if service != "" {
		if err := subscribe(service); err != nil {
			return nil, nil, err
		}
	} else {
		for _, svc := range l.getServicesForEnvLocked(repoID, envID) {
			if err := subscribe(svc); err != nil {
				return nil, nil, err
			}
		}
	}

	cleanup := func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		for _, key := range keys {
			parts := strings.Split(key, "#")
			if len(parts) != 2 {
				continue
			}
			buf := l.buffers[parts[0]]
			if buf == nil {
				continue
			}
			delete(buf.subscribers, atoi(parts[1]))
		}
	}

	return ch, cleanup, nil
}

func (l *LogStreamer) CloseEnv(repoID, envID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	prefix := repoID + ":" + envID + ":"
	seen := map[chan LogLine]bool{}
	for key, buf := range l.buffers {
		if strings.HasPrefix(key, prefix) {
			for _, ch := range buf.subscribers {
				if !seen[ch] {
					close(ch)
					seen[ch] = true
				}
			}
			buf.subscribers = nil
			_ = buf.file.Close()
			delete(l.buffers, key)
		}
	}
}

func (l *LogStreamer) ensureBufferLocked(repoID, envID, service string) (*serviceBuffer, error) {
	key := bufferKey(repoID, envID, service)
	if buf, ok := l.buffers[key]; ok {
		return buf, nil
	}
	if err := EnsureRepoDirs(repoID, envID); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(RepoLogDir(repoID, envID), service+".log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	buf := &serviceBuffer{
		lines:       []LogLine{},
		subscribers: map[int]chan LogLine{},
		file:        file,
	}
	l.buffers[key] = buf
	return buf, nil
}

func (l *LogStreamer) getServicesForEnvLocked(repoID, envID string) []string {
	prefix := repoID + ":" + envID + ":"
	services := []string{}
	for key := range l.buffers {
		if strings.HasPrefix(key, prefix) {
			services = append(services, strings.TrimPrefix(key, prefix))
		}
	}
	sort.Strings(services)
	return services
}

func atoi(value string) int {
	n, _ := strconv.Atoi(value)
	return n
}
