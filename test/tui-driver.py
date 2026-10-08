"""Run the real CLI inside a PTY, without a VS Code desktop."""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)

def stop(_signal, _frame):
    child.terminate()

signal.signal(signal.SIGTERM, stop)
while child.poll() is None:
    ready, _, _ = select.select([master, sys.stdin], [], [], 0.2)
    if sys.stdin in ready:
        keys = os.read(sys.stdin.fileno(), 1024)
        if keys:
            os.write(master, keys)
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        # Respond to terminal capability queries to let OpenTUI initialize.
        if b"\x1b[6n" in data:
            os.write(master, b"\x1b[1;1R")
        if b"\x1b[c" in data:
            os.write(master, b"\x1b[?1;2c")
child.wait(timeout=5)
os.close(master)
sys.exit(child.returncode)
