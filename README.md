# Simple Chat App

后端: Node.js + Express + Socket.IO，聊天记录保存在 `backend/data/messages.json`。

前端: 静态页面，位于 `frontend`。

运行:

1. 进入后端目录并安装依赖

```bash
cd chat-app/backend
npm install
```

2. 启动服务器（默认 http://localhost:3000 ）

```bash
npm start
```

3. 在浏览器打开 `http://localhost:3000`，可同时打开多个窗口模拟多人聊天室。

更新:

1. git clone最新的master分支
2. 执行update.sh