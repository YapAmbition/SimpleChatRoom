# 安装pm2 管理进程
npm install -g pm2

# 运行chatRoom
PORT=20001 npx pm2 start server.js --name chat-room


# 关于pm2:

## 查看运行中的进程
npx pm2 list

## 重启（更新代码后用这个）
npx pm2 restart chat-room

## 停止
npx pm2 stop chat-room

## 启动（停止后再开）
npx pm2 start chat-room

## 删除（彻底移除这个进程记录）
npx pm2 delete chat-room

## 查看实时日志
npx pm2 logs chat-room

## 清除日志
npx pm2 flush chat-room


# 怎么清理聊天记录:

## 先找到房间目录，查看 room.json 里的映射
cat backend/data/rooms/room.json

## 进入对应房间目录，比如
cd backend/data/rooms/<房间目录>

## 清空消息文件
echo '[]' > messages.json
echo -n '' > messages.log
echo '[]' > archives.json

## 删除归档压缩包
rm -f messages-*.json.gz

## 文件
如果还发送过文件，上传的文件统一存在 backend/data/uploads/ 目录下（所有房间共用），需要的话也可以清理，但文件名没有按房间区分，需自行判断。

## 清理后
清理完后建议重启服务 (npx pm2 restart chat-room) 让内存中的缓存刷新