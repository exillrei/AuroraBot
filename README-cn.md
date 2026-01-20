> [!NOTE]
> govnocoded by ChatGPT

# 🌠 AuroraBot - 功能强大的 Minecraft 机器人

机器人包含哪些功能？：  
 **1.** 常用指令  
 **2.** 经济系统  
 **3.** 商店系统  
 **4.** 聊天游戏  
 **5.** 通过 Discord 远程管理  
 **6.** 本地化。支持语言：ru, en, cn  

## 🛠️ 安装步骤

**1.** 安装 [NodeJS](https://nodejs.org/en/download/)  
**2.** 安装完成后，下载 [程序归档](https://github.com/exillrei/AuroraBot/releases)  
**3.** 将归档解压到任意位置，并在该目录下打开终端（命令行）  
**4.** 安装依赖库：  
```npm install```  
**5.** 完成！你已成功安装机器人。如何使用？——请阅读下文  

## 🤔 使用方法

启动机器人：  
```node bot```  

机器人前缀：**$** 机器人指令：  
help - 显示可用指令列表  
msg - 以机器人名义在聊天栏发送消息  
run - 以机器人名义执行服务器指令  
exit - 停止机器人运行  
restart - 重启机器人  
info - 显示机器人信息  
blacklist - 黑名单管理  
ban - 禁止玩家使用机器人  
unban - 解除玩家的封禁状态  
cmd - 授予或撤销指令访问权限  
eco - 机器人经济系统管理  
rape - 💀💀💀  
list - 服务器在线玩家列表  
spammer - 指令刷屏器  
config - 机器人设置  
balance - 查看你的硬币余额  
shop - 商店  
feedback - 机器人评价反馈  
pay - 向其他玩家转账硬币  
code - 兑换码  
bcode - 兑换码通知  

> [!NOTE]
> 使用 restart 指令需要安装 **PM2** > **PM2** 安装指令：  
> ```npm install pm2```  
> 通过 **PM2** 启动机器人：  
> ```pm2 start ecosystem.config.cjs```  

> [!NOTE]
> 请记得根据你的需求修改 **main.js** 和 **.env** 文件