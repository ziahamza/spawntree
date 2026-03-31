package daemon

import (
	"fmt"
	"sync"
	"time"
)

const (
	portRangeSize  = 100
	portRangeStart = 10000
	maxPortSlots   = 100
)

type PortRegistry struct {
	mu    sync.RWMutex
	slots []PortSlot
}

func NewPortRegistry() (*PortRegistry, error) {
	state, err := LoadPortRegistry()
	if err != nil {
		return nil, err
	}
	return &PortRegistry{slots: state.Slots}, nil
}

func (p *PortRegistry) Allocate(envKey string) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	for _, slot := range p.slots {
		if slot.EnvKey == envKey {
			return slot.BasePort, nil
		}
	}

	used := map[int]bool{}
	for _, slot := range p.slots {
		used[(slot.BasePort-portRangeStart)/portRangeSize] = true
	}
	for i := 0; i < maxPortSlots; i++ {
		if used[i] {
			continue
		}
		basePort := portRangeStart + i*portRangeSize
		p.slots = append(p.slots, PortSlot{
			EnvKey:      envKey,
			BasePort:    basePort,
			AllocatedAt: time.Now().UTC().Format(time.RFC3339),
		})
		if err := p.persist(); err != nil {
			return 0, err
		}
		return basePort, nil
	}
	return 0, fmt.Errorf("all %d port slots are in use", maxPortSlots)
}

func (p *PortRegistry) Free(envKey string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	filtered := make([]PortSlot, 0, len(p.slots))
	for _, slot := range p.slots {
		if slot.EnvKey != envKey {
			filtered = append(filtered, slot)
		}
	}
	p.slots = filtered
	return p.persist()
}

func (p *PortRegistry) GetPhysicalPort(basePort, serviceIndex int) (int, error) {
	if serviceIndex >= portRangeSize {
		return 0, fmt.Errorf("service index %d exceeds port range size %d", serviceIndex, portRangeSize)
	}
	return basePort + serviceIndex, nil
}

func (p *PortRegistry) GetBasePort(envKey string) *int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	for _, slot := range p.slots {
		if slot.EnvKey == envKey {
			value := slot.BasePort
			return &value
		}
	}
	return nil
}

func (p *PortRegistry) List() []PortSlot {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]PortSlot, len(p.slots))
	copy(out, p.slots)
	return out
}

func (p *PortRegistry) persist() error {
	return SavePortRegistry(PortRegistryState{Slots: p.slots})
}
