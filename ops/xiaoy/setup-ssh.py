#!/usr/bin/env python3
"""Install the local xiaoy SSH alias using the existing key and host trust.

Run in the user's Mac Terminal. Does not read key contents, change the server,
grant a tool network access, alter budgets, or start a background process.
"""
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import tempfile
import time

BEGIN = '# BEGIN edulab xiaoy SSH alias'
END = '# END edulab xiaoy SSH alias'
BLOCK = '''# BEGIN edulab xiaoy SSH alias
Host xiaoy
    HostName 43.173.94.201
    User root
    Port 22
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    PreferredAuthentications publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    BatchMode yes
    StrictHostKeyChecking yes
    ConnectTimeout 10
    ServerAliveInterval 30
    ServerAliveCountMax 3
# END edulab xiaoy SSH alias
'''


def build_config(original):
    if BEGIN in original or END in original:
        if original.count(BEGIN) != 1 or original.count(END) != 1:
            raise ValueError('EXISTING_ALIAS_REQUIRES_REVIEW')
        start = original.index(BEGIN)
        stop = original.index(END, start) + len(END)
        if original[start:stop] != BLOCK.rstrip('\n'):
            raise ValueError('EXISTING_ALIAS_REQUIRES_REVIEW')
        return original
    for line in original.splitlines():
        parts = shlex.split(line, comments=True)
        if parts and parts[0].lower() == 'host' and any(p.lower() == 'xiaoy' for p in parts[1:]):
            raise ValueError('EXISTING_ALIAS_REQUIRES_REVIEW')
    return BLOCK + '\n' + original


def validate_config(path):
    result = subprocess.run(['ssh', '-G', '-F', str(path), 'xiaoy'],
                            capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise ValueError('CONFIG_VALIDATION_FAILED')
    fields = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition(' ')
        fields.setdefault(key, []).append(value)
    expected = {'hostname': '43.173.94.201', 'user': 'root', 'port': '22',
                'identitiesonly': 'yes', 'batchmode': 'yes',
                'stricthostkeychecking': 'true', 'passwordauthentication': 'no',
                'kbdinteractiveauthentication': 'no'}
    if any(fields.get(k) != [v] for k, v in expected.items()):
        raise ValueError('CONFIG_VALIDATION_FAILED')


def main():
    if not os.isatty(0):
        raise ValueError('USER_TERMINAL_REQUIRED')
    directory = Path.home() / '.ssh'
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('EXISTING_SSH_DIRECTORY_REQUIRED')
    key = directory / 'id_ed25519'
    if not key.is_file() or stat.S_IMODE(key.stat().st_mode) & 0o077:
        raise ValueError('EXISTING_PRIVATE_KEY_REQUIRED')
    trusted = subprocess.run(['ssh-keygen', '-F', '43.173.94.201', '-f', str(directory / 'known_hosts')],
                             capture_output=True, timeout=10)
    if trusted.returncode:
        raise ValueError('EXISTING_TRUSTED_HOST_REQUIRED')
    path = directory / 'config'
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError('CONFIG_REQUIRES_REVIEW')
    original = path.read_bytes() if path.exists() else None
    if original is not None and len(original) > 262144:
        raise ValueError('CONFIG_REQUIRES_REVIEW')
    updated = build_config((original or b'').decode('utf-8')).encode('utf-8')
    fd, candidate = tempfile.mkstemp(prefix='.xiaoy-', dir=directory)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(updated)
        validate_config(candidate)
        current = path.read_bytes() if path.exists() else None
        if current != original or path.is_symlink():
            raise ValueError('CONFIG_CHANGED')
        if original is not None and original != updated:
            backup_fd, backup = tempfile.mkstemp(prefix='config.before-xiaoy-', dir=directory)
            os.fchmod(backup_fd, 0o600)
            with os.fdopen(backup_fd, 'wb') as stream:
                stream.write(original)
        if original != updated:
            os.replace(candidate, path)
    finally:
        if os.path.exists(candidate):
            os.unlink(candidate)
    result = {'alias': 'xiaoy', 'name': '小y', 'host': '43.173.94.201',
              'aliasConfigured': True, 'serverChanged': False, 'recordedAt': time.time()}
    try:
        check = subprocess.run(['ssh', 'xiaoy', 'true'], capture_output=True, timeout=15)
        result['passwordlessConnectionVerified'] = check.returncode == 0
    except subprocess.TimeoutExpired:
        result['passwordlessConnectionVerified'] = False
    fd, name = tempfile.mkstemp(prefix='xiaoy-setup-', suffix='.json', dir='/tmp')
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(result, stream, ensure_ascii=False)
    receipt = Path('/tmp/xiaoy-ssh-setup-result.json')
    os.replace(name, receipt)
    print('小y登录别名已保存。以后在终端输入：ssh xiaoy')
    print('免密连接验证：' + ('通过' if result['passwordlessConnectionVerified'] else '未通过，配置已保留，未修改服务器'))
    print('注意：此设置不会改变ChatGPT当前执行环境的SSH网络权限。')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        allowed = {'EXISTING_ALIAS_REQUIRES_REVIEW', 'CONFIG_VALIDATION_FAILED',
                   'USER_TERMINAL_REQUIRED', 'EXISTING_SSH_DIRECTORY_REQUIRED',
                   'EXISTING_PRIVATE_KEY_REQUIRED', 'EXISTING_TRUSTED_HOST_REQUIRED',
                   'CONFIG_REQUIRES_REVIEW', 'CONFIG_CHANGED'}
        code = str(error) if str(error) in allowed else 'SETUP_FAILED'
        print('小y配置未完成：' + code)
        raise SystemExit(1) from None
