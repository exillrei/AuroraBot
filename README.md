> [!NOTE]
> govnocoded by ChatGPT

[Русская версия](https://github.com/exillrei/AuroraBot/blob/main/README-ru.md)
[中文版本](https://github.com/exillrei/AuroraBot/blob/main/README-cn.md)
# 🌠 AuroraBot - A functional bot for Minecraft

What features are in the bot?:  
 **1.** Commands  
 **2.** Economy  
 **3.** Shop  
 **4.** Chat-Game  
 **5.** Bot management via Discord  
 **6.** Localization. Available languages: ru, en, cn  

## 🛠️ Installation

**1.** Install [NodeJS](https://nodejs.org/en/download/)  
**2.** After installation, download the [archive](https://github.com/exillrei/AuroraBot/releases)  
**3.** Extract the archive anywhere and open a terminal (command prompt) there  
**4.** Install dependencies:  
```npm install```  
**5.** Done! You have installed the bot. How to use? - written below  

## 🤔 Usage

Starting the bot:  
```node bot```  

Bot prefix: **$** Bot commands:  
help - Shows the list of available commands  
msg - Sends a message in chat as the bot  
run - Executes a server command as the bot  
exit - Shut down the bot  
restart - Restart the bot  
info - Shows bot information  
blacklist - Blacklist management  
ban - Block a player from using the bot  
unban - Removes a ban from a player  
cmd - Grants or revokes access to commands  
eco - Bot economy management  
rape - 💀💀💀  
list - List of players on the server  
spammer - Command spammer  
config - Bot settings  
balance - Show your coin balance  
shop - Shop  
feedback - Bot reviews  
pay - Send your coins to a player  
code - Codes  
bcode - Code notification  

> [!NOTE]
> The restart command requires **PM2** > **PM2** installation:  
> ```npm install pm2```  
> Starting the bot via **PM2**:  
> ```pm2 start ecosystem.config.cjs```  

> [!NOTE]
> Don't forget to edit **main.js** and **.env** for yourself