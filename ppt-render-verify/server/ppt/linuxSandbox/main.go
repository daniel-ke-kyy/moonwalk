//go:build linux

// The web process supplies a policy, never credentials. The child gets a fresh
// user/PID/network namespace and must enforce every restriction before exec.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	seccomp "github.com/elastic/go-seccomp-bpf"
	"github.com/landlock-lsm/go-landlock/landlock"
	"golang.org/x/sys/unix"
)

type policy struct {
	Read          []string `json:"read"`
	Write         []string `json:"write"`
	Port          int      `json:"port"`
	TimeoutMillis int      `json:"timeoutMillis"`
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "PPT isolation:", err)
	os.Exit(125)
}

func loopback() error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	ifr, err := unix.NewIfreq("lo")
	if err != nil {
		return err
	}
	if err = unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr); err != nil {
		return err
	}
	ifr.SetUint16(ifr.Uint16() | unix.IFF_UP)
	return unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr)
}

func restrictions(p policy) error {
	if p.Port != 0 && (p.Port < 1024 || p.Port > 65535) {
		return errors.New("invalid loopback port")
	}
	if p.Port != 0 {
		if err := loopback(); err != nil {
			return fmt.Errorf("loopback: %w", err)
		}
	}
	var rules []landlock.Rule
	for _, name := range p.Read {
		info, err := os.Stat(name)
		if err != nil {
			return err
		}
		if info.IsDir() {
			rules = append(rules, landlock.RODirs(name))
		} else {
			rules = append(rules, landlock.ROFiles(name))
		}
	}
	for _, name := range p.Write {
		info, err := os.Stat(name)
		if err != nil {
			return err
		}
		if info.IsDir() {
			rules = append(rules, landlock.RWDirs(name).WithRefer())
		} else {
			rules = append(rules, landlock.RWFiles(name))
		}
	}
	if p.Port != 0 {
		rules = append(rules, landlock.BindTCP(uint16(p.Port)), landlock.ConnectTCP(uint16(p.Port)))
	}
	// No BestEffort: ABI 4, including truncation, rename and TCP restrictions,
	// is mandatory. A separate network namespace also contains UDP/MPTCP/UNIX IPC.
	if err := landlock.V4.Restrict(rules...); err != nil {
		return fmt.Errorf("landlock: %w", err)
	}
	for cap := 0; cap <= 40; cap++ {
		if err := unix.Prctl(unix.PR_CAPBSET_DROP, uintptr(cap), 0, 0, 0); err != nil && err != unix.EINVAL {
			return err
		}
	}
	header := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	data := [2]unix.CapUserData{}
	if err := unix.Capset(&header, &data[0]); err != nil {
		return err
	}
	return seccomp.LoadFilter(seccomp.Filter{
		NoNewPrivs: true, Flag: seccomp.FilterFlagTSync,
		Policy: seccomp.Policy{DefaultAction: seccomp.ActionAllow, Syscalls: []seccomp.SyscallGroup{{
			Action: seccomp.ActionErrno, Names: []string{
				"ptrace", "process_vm_readv", "process_vm_writev", "pidfd_getfd",
				"mount", "umount2", "pivot_root", "setns", "unshare",
				"open_by_handle_at", "name_to_handle_at", "bpf", "perf_event_open",
				"userfaultfd", "io_uring_setup", "kexec_load", "init_module", "finit_module", "delete_module",
			},
			// ABI 4 does not control pathname UNIX sockets. Keep socketpair for
			// local pipes/Chromium IPC, but deny opening connections to host sockets.
			NamesWithCondtions: []seccomp.NameWithConditions{{Name: "socket", Conditions: seccomp.ArgumentConditions{
				{Argument: 0, Operation: seccomp.Equal, Value: unix.AF_UNIX},
			}}},
		}}},
	})
}

func main() {
	if len(os.Args) < 3 {
		fail(errors.New("expected policy and command"))
	}
	inner := os.Args[1] == "--inner"
	offset := 1
	if inner {
		offset++
	}
	if len(os.Args) <= offset+1 {
		fail(errors.New("missing command"))
	}
	var p policy
	if err := json.Unmarshal([]byte(os.Args[offset]), &p); err != nil {
		fail(err)
	}
	if inner {
		if os.Getpid() != 1 {
			fail(errors.New("missing PID namespace"))
		}
		if err := restrictions(p); err != nil {
			fail(err)
		}
	} else {
		if os.Getuid() == 0 {
			fail(errors.New("outer worker must not run as root"))
		}
		executable, err := os.Executable()
		if err != nil {
			fail(err)
		}
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer stop()
		deadline := p.TimeoutMillis
		if deadline <= 0 {
			deadline = 122000
		}
		ctx, cancel := context.WithTimeout(ctx, time.Duration(deadline)*time.Millisecond)
		defer cancel()
		// Render may deny signals from the root web process to a different UID.
		// A private inherited pipe provides cancellation and detects parent death;
		// it is not forwarded to the namespace child.
		control := os.NewFile(3, "cancel")
		if control == nil {
			fail(errors.New("missing cancellation channel"))
		}
		go func() { var b [1]byte; _, _ = io.ReadFull(control, b[:]); cancel() }()
		cmd := exec.CommandContext(ctx, executable, append([]string{"--inner"}, os.Args[1:]...)...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		cmd.Env = os.Environ()
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Cloneflags:                 unix.CLONE_NEWUSER | unix.CLONE_NEWPID | unix.CLONE_NEWNET,
			UidMappings:                []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}},
			GidMappings:                []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}},
			GidMappingsEnableSetgroups: false, Pdeathsig: syscall.SIGKILL,
		}
		run(cmd)
		return
	}
	cmd := exec.Command(os.Args[offset+1], os.Args[offset+2:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = os.Environ()
	// PID 1 stays alive until the native tool exits. Namespace teardown kills
	// descendants, even if they detached from the original process group.
	run(cmd)
}

func run(cmd *exec.Cmd) {
	if err := cmd.Run(); err != nil {
		var exited *exec.ExitError
		if errors.As(err, &exited) && exited.ExitCode() >= 0 {
			os.Exit(exited.ExitCode())
		}
		fail(err)
	}
}
