//go:build linux

package main

import (
	"errors"
	"os/exec"
)

// errElevationCancelled is returned when the user dismisses the PolicyKit prompt.
var errElevationCancelled = errors.New("elevation cancelled")

// runElevatedAndWait runs the guard binary as root via pkexec (which shows a
// PolicyKit authentication dialog), waits for it to finish, and returns its exit
// code. A dismissed/unauthorized dialog surfaces as errElevationCancelled.
func runElevatedAndWait(exe string, args []string) (int, error) {
	cmd := exec.Command("pkexec", append([]string{exe}, args...)...)
	err := cmd.Run()
	if err == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		// pkexec exit codes: 126 = not authorized / dialog dismissed,
		// 127 = the program could not be executed.
		if code := ee.ExitCode(); code == 126 || code == 127 {
			return 0, errElevationCancelled
		} else {
			return code, nil
		}
	}
	return 0, err
}
