#!/usr/bin/env python3
"""Own an OS lock across exec, never infer ownership from PID or file age.

Usage: python3 runtime-epoch-coordinator-lock.py /absolute/lock -- node ...
The lock's parent must already exist as a private directory. Exit 73 means busy.
"""
import fcntl
import os
import stat
import subprocess
import sys


def private_lock(path):
    if not os.path.isabs(path):
        raise ValueError('absolute_lock_path_required')
    parent = os.stat(os.path.dirname(path))
    if parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('private_lock_directory_required')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        os.close(fd)
        raise ValueError('private_regular_lock_required')
    os.fchmod(fd, 0o600)
    return fd


def verify_fd(fd, path):
    # An inherited descriptor must name the expected inode AND hold the lock.
    # A fresh process/open of the same path must be denied while we hold it.
    held, named = os.fstat(fd), os.stat(path, follow_symlinks=False)
    if (held.st_dev, held.st_ino) != (named.st_dev, named.st_ino):
        return 1
    try:
        # Another owner's lock must not validate our unowned descriptor.
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 1
    result = subprocess.run([sys.executable, __file__, '--probe', path], close_fds=True,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return 0 if result.returncode == 73 else 1


def main(args):
    if len(args) == 3 and args[0] == '--verify-fd':
        return verify_fd(int(args[1]), args[2])
    probe = len(args) == 2 and args[0] == '--probe'
    if not probe and (len(args) < 3 or args[1] != '--'):
        raise ValueError('usage_lock_path_separator_command')
    fd = private_lock(args[1] if probe else args[0])
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 73
        if probe:
            return 0
        os.set_inheritable(fd, True)
        env = dict(os.environ, RUNTIME_EPOCH_COORDINATOR_LOCK_FD=str(fd))
        os.execvpe(args[2], args[2:], env)
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, ValueError):
        print('runtime_epoch_coordinator_lock_failed', file=sys.stderr)
        sys.exit(1)
