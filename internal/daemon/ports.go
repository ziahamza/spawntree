package daemon

import "fmt"

const (
	portRangeSize  = 100
	portRangeStart = 10000
	maxPortSlots   = 100
)

type PortRegistry struct {
	store *StateStore
}

func NewPortRegistry(store *StateStore) *PortRegistry {
	return &PortRegistry{store: store}
}

func (p *PortRegistry) Allocate(envKey EnvKey) (Port, error) {
	return p.store.AllocatePort(envKey)
}

func (p *PortRegistry) Free(envKey EnvKey) error {
	return p.store.FreePort(envKey)
}

func (p *PortRegistry) GetPhysicalPort(basePort Port, serviceIndex int) (Port, error) {
	if serviceIndex < 0 {
		return 0, fmt.Errorf("service index %d is negative", serviceIndex)
	}
	if serviceIndex >= portRangeSize {
		return 0, fmt.Errorf("service index %d exceeds port range size %d", serviceIndex, portRangeSize)
	}
	return basePort + Port(serviceIndex), nil
}

func (p *PortRegistry) GetBasePort(envKey EnvKey) *Port {
	return p.store.GetBasePort(envKey)
}

func (p *PortRegistry) List() []PortSlot {
	return p.store.ListPortSlots()
}
