// Windows x64/ARM64 companion to bin/run-node. Node and FFmpeg remain external dependencies.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// Reserved for rejecting a Node candidate before it can consume hook stdin.
const unsupportedNodeExit = 78
const nodeCheck = `const [a,b]=process.versions.node.split(".").map(Number);if(!["x64","arm64"].includes(process.arch)||a<22||(a===22&&b<16))process.exit(78);try{require("node:sqlite")}catch{process.exit(78)}`

func candidates() []string {
	if override := os.Getenv("HONGGUO_NODE"); override != "" {
		return []string{override}
	}
	var result []string
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		dir = strings.Trim(dir, "\"")
		if filepath.IsAbs(dir) {
			result = append(result, filepath.Join(dir, "node.exe"))
		}
	}
	for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramW6432"), os.Getenv("LOCALAPPDATA")} {
		if filepath.IsAbs(base) {
			result = append(result, filepath.Join(base, "nodejs", "node.exe"))
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		result = append(result, filepath.Join(home, ".volta", "bin", "node.exe"), filepath.Join(home, "scoop", "apps", "nodejs-lts", "current", "node.exe"))
	}
	for _, key := range []string{"NVM_SYMLINK", "VOLTA_HOME"} {
		if dir := os.Getenv(key); filepath.IsAbs(dir) {
			if key == "VOLTA_HOME" {
				dir = filepath.Join(dir, "bin")
			}
			result = append(result, filepath.Join(dir, "node.exe"))
		}
	}
	return result
}

func usable(node string) bool {
	if !filepath.IsAbs(node) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	probe := exec.CommandContext(ctx, node, "--no-warnings", "-e", nodeCheck)
	probe.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	// The probe never consumes the hook's stdin or forwards runtime diagnostics.
	return probe.Run() == nil
}

// Closing this non-inherited handle kills Node too if the host terminates the launcher.
func processJob() (syscall.Handle, error) {
	kernel := syscall.NewLazyDLL("kernel32.dll")
	handle, _, err := kernel.NewProc("CreateJobObjectW").Call(0, 0)
	if handle == 0 {
		return 0, err
	}
	job := syscall.Handle(handle)
	// JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows; LimitFlags is at byte 16.
	info := [144]byte{}
	*(*uint32)(unsafe.Pointer(&info[16])) = 0x2000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	ok, _, err := kernel.NewProc("SetInformationJobObject").Call(handle, 9, uintptr(unsafe.Pointer(&info[0])), uintptr(len(info)))
	if ok != 0 {
		current, _ := syscall.GetCurrentProcess()
		ok, _, err = kernel.NewProc("AssignProcessToJobObject").Call(handle, uintptr(current))
	}
	if ok == 0 {
		syscall.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func nativeArm64() bool {
	query := syscall.NewLazyDLL("kernel32.dll").NewProc("IsWow64Process2")
	if query.Find() != nil {
		return false
	}
	var processMachine, nativeMachine uint16
	current, _ := syscall.GetCurrentProcess()
	ok, _, _ := query.Call(uintptr(current), uintptr(unsafe.Pointer(&processMachine)), uintptr(unsafe.Pointer(&nativeMachine)))
	return ok != 0 && nativeMachine == 0xaa64
}

func execute(command *exec.Cmd) int {
	if _, err := processJob(); err != nil {
		fmt.Fprintln(os.Stderr, "Unable to initialize the Windows runtime job.")
		return 1
	}
	// The OS closes the job handle at process exit. Closing it here would kill this launcher too.
	status, _ := executeProcess(command)
	return status
}

func executeProcess(command *exec.Cmd) (int, bool) {
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := command.Run(); err != nil {
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			return exited.ExitCode(), true
		}
		return 1, false
	}
	return 0, true
}

func runHook(target string) int {
	if _, err := processJob(); err != nil {
		fmt.Fprintln(os.Stderr, "Unable to initialize the Windows runtime job.")
		return 1
	}
	// Cold Windows/ARM startup must not launch Node twice within one hook deadline.
	// Validate in the same process that imports the hook, without reading stdin until
	// a compatible runtime has been selected. A rejected candidate leaves stdin intact.
	bootstrap := nodeCheck + `;import(require("node:url").pathToFileURL(process.argv[1]).href).catch(()=>{process.stderr.write("Hongguo hook failed to start.\n");process.exitCode=1})`
	for _, node := range candidates() {
		if !filepath.IsAbs(node) {
			continue
		}
		status, started := executeProcess(exec.Command(node, "--no-warnings", "-e", bootstrap, "--", target))
		if !started || status == unsupportedNodeExit {
			continue
		}
		return status
	}
	fmt.Fprintln(os.Stderr, "Hongguo requires Node.js x64 or ARM64 >=22.16 with node:sqlite. Install it, restart Codex, then run Setup. Check HONGGUO_NODE if configured.")
	return 1
}

func run() int {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "Usage: run-node server|hook|check")
		return 2
	}
	targets := map[string]string{"server": "server/index.mjs", "hook": "hooks/write.mjs", "check": "setup/check.mjs"}
	target, ok := targets[os.Args[1]]
	if !ok {
		fmt.Fprintln(os.Stderr, "Usage: run-node server|hook|check")
		return 2
	}
	launcher, err := os.Executable()
	if err != nil {
		return 1
	}
	// The fixed MCP/Hook entry remains compatible with x64 hosts. On Windows ARM,
	// its short bootstrap runs under Windows' x64 emulation and delegates to ARM64.
	if runtime.GOARCH == "amd64" && nativeArm64() {
		return execute(exec.Command(filepath.Join(filepath.Dir(launcher), "run-node-arm64.exe"), os.Args[1:]...))
	}
	if os.Args[1] == "hook" {
		return runHook(filepath.Join(filepath.Dir(launcher), "..", "dist", target))
	}
	for _, node := range candidates() {
		if !usable(node) {
			continue
		}
		return execute(exec.Command(node, "--no-warnings", filepath.Join(filepath.Dir(launcher), "..", "dist", target)))
	}
	fmt.Fprintln(os.Stderr, "Hongguo requires Node.js x64 or ARM64 >=22.16 with node:sqlite. Install it, restart Codex, then run Setup. Check HONGGUO_NODE if configured.")
	return 1
}

func main() { os.Exit(run()) }
