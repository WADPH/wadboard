# Wadboard — Your own simple dashboard 

<img width="1084" height="989" alt="image" src="https://github.com/user-attachments/assets/cff53d89-af31-4b11-a705-76aa5bfa00bb" />

## Requirements

1. Node.js 18+ (LTS recommended) and npm

2. Ping binary available in PATH (iputils/inetutils/BusyBox)

3. MikroTik with REST API enabled if you use WOL (/ip/service set www-ssl/api-ssl … or /rest on RouterOS v7)


## Installation
1. Install Node.js and ping
      ```bash
      # Debian/Ubuntu:
      sudo apt update && sudo apt install -y nodejs npm iputils-ping
   ```

2. Clone the project
      ```bash
      git clone https://github.com/WADPH/wadboard.git
      cd wadboard
   ```

3. Install backend deps
    ```bash
    cd backend
    npm ci   # or: npm install
   ```

## Usage

1. Default settings pass is "wadboard". Change it in backend/server.js:
   ```bash 
   // -----------------------
   // Admin password (change this)
   // -----------------------
   const ADMIN_PASSWORD = "wadboard";
   ```


2. Go to backend/ and execute:
   ```bash
   setsid node server.js # or setsid node server.js >> /path/to/log_file.log
   ```


## Project/Repo Structure <br>

```bash
.
├── LICENSE
├── README.md
├── backend
│   ├── data.json          #<— Wadboard Date Base file, like your custom services, quick links ans etc...
│   ├── package-lock.json  #<— Versions
│   ├── package.json       #<— Versions
│   └── server.js          #<— Main backend file, checking services status, sending WoL and etc...
└── frontend
    └── index.html         #<— Frontend file (css/js included)

3 directories, 7 files
```
