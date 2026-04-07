import { loadPortRegistry, type PortSlot, savePortRegistry } from "../state/global-state.ts";

const PORT_RANGE_SIZE = 100;
const PORT_RANGE_START = 10000;
const MAX_SLOTS = 100;

/**
 * Global port allocator backed by ~/.spawntree/port-registry.json.
 * No file locking needed — the daemon serializes all requests in-memory.
 */
export class PortRegistry {
  private slots: PortSlot[];

  constructor() {
    const state = loadPortRegistry();
    this.slots = state.slots;
  }

  /**
   * Allocate a port range for the given env key.
   * Returns the base port (first-fit-free-slot).
   * Idempotent: returns existing allocation if already present.
   */
  allocate(envKey: string): number {
    const existing = this.slots.find((s) => s.envKey === envKey);
    if (existing) {
      return existing.basePort;
    }

    const usedSlotIndices = new Set(
      this.slots.map((s) => (s.basePort - PORT_RANGE_START) / PORT_RANGE_SIZE),
    );

    let slotIndex = -1;
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (!usedSlotIndices.has(i)) {
        slotIndex = i;
        break;
      }
    }

    if (slotIndex === -1) {
      throw new Error(
        `All ${MAX_SLOTS} port slots are in use. `
          + `Remove unused environments to free slots.`,
      );
    }

    const basePort = PORT_RANGE_START + slotIndex * PORT_RANGE_SIZE;

    this.slots.push({
      envKey,
      basePort,
      allocatedAt: new Date().toISOString(),
    });

    this.persist();
    return basePort;
  }

  /**
   * Free the port range for the given env key.
   */
  free(envKey: string): void {
    const before = this.slots.length;
    this.slots = this.slots.filter((s) => s.envKey !== envKey);
    if (this.slots.length !== before) {
      this.persist();
    }
  }

  /**
   * Get the physical port for a service within an environment.
   * Services are zero-indexed in YAML declaration order.
   */
  getPhysicalPort(basePort: number, serviceIndex: number): number {
    if (serviceIndex >= PORT_RANGE_SIZE) {
      throw new Error(
        `Service index ${serviceIndex} exceeds port range size ${PORT_RANGE_SIZE}`,
      );
    }
    return basePort + serviceIndex;
  }

  /**
   * Get the base port for a given env key, or undefined if not allocated.
   */
  getBasePort(envKey: string): number | undefined {
    return this.slots.find((s) => s.envKey === envKey)?.basePort;
  }

  /**
   * List all current allocations.
   */
  list(): PortSlot[] {
    return [...this.slots];
  }

  private persist(): void {
    savePortRegistry({ slots: this.slots });
  }
}
