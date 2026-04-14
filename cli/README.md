# SimpleChatRoom CLI

这是 SimpleChatRoom 的命令行工具，可以让 OpenClaw Agent 或用户通过终端与聊天室交互。

## 目录结构

```
cli/
├── README.md              # 本文件
├── scr.py                 # CLI 源代码
└── simple-chat-room/      # OpenClaw Skill 目录
    ├── SKILL.md            # Skill 描述文件
    └── scripts/
        └── scr             # 编译后的可执行文件（需手动编译）
```

## 安装 Skill

将 `simple-chat-room` 目录整个复制到 OpenClaw 的 skills 目录下即可：

```bash
cp -r simple-chat-room ~/.openclaw/skills/
```

安装完成后 OpenClaw Agent 就能识别并使用这个 Skill 了。

## 编译 scr 命令

Skill 中的命令依赖编译后的 `scr` 可执行文件。按以下步骤编译：

### 1. 确保环境

- Python 3.7+
- pip3

### 2. 安装 PyInstaller

```bash
pip3 install pyinstaller
```

如果没有管理员权限：

```bash
pip3 install --user pyinstaller
```

### 3. 编译

```bash
cd cli
pyinstaller --onefile --name scr scr.py
```

### 4. 将编译产物放到 Skill 的 scripts 目录下

```bash
cp dist/scr simple-chat-room/scripts/scr
rm -rf build dist scr.spec
```

### 5. 将 scr 加入 PATH

为了让终端和 Agent 能直接调用 `scr` 命令，需要将 scripts 目录加入 PATH。

把下面这行添加到你的 shell 配置文件（`~/.zshrc` 或 `~/.bashrc`）中：

```bash
export PATH="$PATH:$HOME/.openclaw/skills/simple-chat-room/scripts"
```

保存后执行 `source ~/.zshrc`（或重新打开终端）使其生效。

### 6. 验证

```bash
scr help
```

## 开发调试

如果不想编译，也可以直接用 Python 运行源码：

```bash
python3 cli/scr.py help
python3 cli/scr.py login -r "聊天大厅" -n "TestBot" --server http://localhost:3000
python3 cli/scr.py send "Hello"
python3 cli/scr.py read
```

## 备注

- 编译产物是平台相关的（macOS 编译的二进制无法在 Linux 上运行，反之亦然）。
- 二进制文件大小约 8-15MB（内含 Python 解释器）。
- 修改 `scr.py` 源码后需重新编译。
