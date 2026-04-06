import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface PortSlot {
  envName: string;
  basePort: number;
  pid: number;
  createdAt: string;
}

interface PortsState {
  slots: PortSlot[];
}

const PORT_RANGE_SIZE = 100;
const PORT_RANGE_START = 10000;
const MAX_SLOTS = 100;

export class PortAllocator {
  private readonly portsFile: string;
  private readonly lockFile: string;

  constructor(spawntreeDir: string, lockFile?: string) {
    this.portsFile = resolve(spawntreeDir, "ports.json");
    this.lockFile = lockFile || resolve(dirname(spawntreeDir), ".spawntree.lock");
  }

  /**
   * Allocate a port range for the given environment.
   * Uses file locking to prevent concurrent access.
   * Returns the base port for the allocated range.
   */
  allocate(envName: string, pid: number): number {
    return this.withLock(() => {
      const state = this.readState();

      // Check for existing allocation
      const existing = state.slots.find((s) => s.envName === envName);
      if (existing) {
        existing.pid = pid;
        this.writeState(state);
        return existing.basePort;
      }

      // Clean up stale slots (PIDs that no longer exist)
      state.slots = state.slots.filter((slot) => this.isPidAlive(slot.pid));

      // Find first free slot
      const usedSlots = new Set(
        state.slots.map((s) => (s.basePort - PORT_RANGE_START) / PORT_RANGE_SIZE),
      );

      let slotIndex = -1;
      for (let i = 0; i < MAX_SLOTS; i++) {
        if (!usedSlots.has(i)) {
          slotIndex = i;
          break;
        }
      }

      if (slotIndex === -1) {
        throw new Error(
          `All ${MAX_SLOTS} port slots are in use. `
            + `Run "spawntree rm" to free unused environments.`,
        );
      }

      const basePort = PORT_RANGE_START + slotIndex * PORT_RANGE_SIZE;

      state.slots.push({
        envName,
        basePort,
        pid,
        createdAt: new Date().toISOString(),
      });

      this.writeState(state);
      return basePort;
    });
  }

  /**
   * Free the port range for the given environment.
   */
  free(envName: string): void {
    this.withLock(() => {
      const state = this.readState();
      state.slots = state.slots.filter((s) => s.envName !== envName);
      this.writeState(state);
    });
  }

  /**
   * Get port allocation for an environment.
   */
  get(envName: string): PortSlot | undefined {
    const state = this.readState();
    return state.slots.find((s) => s.envName === envName);
  }

  /**
   * List all allocated port slots.
   */
  list(): PortSlot[] {
    return this.readState().slots;
  }

  /**
   * Calculate the physical port for a service within an environment.
   * Services are assigned in YAML declaration order (zero-indexed).
   */
  static physicalPort(basePort: number, serviceIndex: number): number {
    if (serviceIndex >= PORT_RANGE_SIZE) {
      throw new Error(
        `Service index ${serviceIndex} exceeds port range size ${PORT_RANGE_SIZE}`,
      );
    }
    return basePort + serviceIndex;
  }

  private readState(): PortsState {
    try {
      const content = readFileSync(this.portsFile, "utf-8");
      return JSON.parse(content) as PortsState;
    } catch {
      return { slots: [] };
    }
  }

  private writeState(state: PortsState): void {
    mkdirSync(dirname(this.portsFile), { recursive: true });
    writeFileSync(this.portsFile, JSON.stringify(state, null, 2) + "\n");
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private withLock<T>(fn: () => T): T {
    mkdirSync(dirname(this.lockFile), { recursive: true });

    let fd: number;
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds total

    while (true) {
      try {
        fd = openSync(this.lockFile, "wx");
        // Write our PID to the lock file for stale detection
        writeFileSync(this.lockFile, String(process.pid));
        break;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          // Check if lock holder is still alive
          try {
            const holderPid = parseInt(readFileSync(this.lockFile, "utf-8").trim(), 10);
            if (!this.isPidAlive(holderPid)) {
              // Stale lock, remove and retry
              unlinkSync(this.lockFile);
              continue;
            }
          } catch {
            // Can't read lock file, remove and retry
            try {
              unlinkSync(this.lockFile);
            } catch {
              // ignore
            }
            continue;
          }

          attempts++;
          if (attempts >= maxAttempts) {
            throw new Error(
              "Timed out waiting for lock. Another spawntree instance may be running.",
            );
          }

          // Wait 100ms and retry
          const start = Date.now();
          while (Date.now() - start < 100) {
            // busy wait (sync context)
          }
          continue;
        }
        throw err;
      }
    }

    try {
      return fn();
    } finally {
      try {
        closeSync(fd!);
        unlinkSync(this.lockFile);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
