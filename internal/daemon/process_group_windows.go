//go:build windows

package daemon

import (
	"os"
	"os/exec"
)

func applyProcessGroup(cmd *exec.Cmd) {}

func terminateProcessGroup(pid int) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Kill()
}

func forceKillProcessGroup(pid int) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Kill()
}
