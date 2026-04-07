# 安装pm2 管理进程
npm install -g pm2

#运行chatRoom

PORT=20001 npx pm2 start server.js --name chat-room


# 关于pm2:

# 查看运行中的进程
npx pm2 list

# 重启（更新代码后用这个）
npx pm2 restart chat-room

# 停止
npx pm2 stop chat-room

# 启动（停止后再开）
npx pm2 start chat-room

# 删除（彻底移除这个进程记录）
npx pm2 delete chat-room

# 查看实时日志
npx pm2 logs chat-room

# 清除日志
npx pm2 flush chat-room