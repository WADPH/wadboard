# Wadboard — Your own simple dashboard 

<img width="1084" height="989" alt="image" src="https://github.com/user-attachments/assets/cff53d89-af31-4b11-a705-76aa5bfa00bb" />


## First Steps

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
│   ├── data.json          #<— wadboard Date Base file, like your custom services, quick links ans etc...
│   ├── package-lock.json  #<— Versions
│   ├── package.json       #<— Versions
│   └── server.js          #<—main backend file, checking services status, sending WoL and etc...
└── frontend
    └── index.html         #<— frontend file (css/js included)

3 directories, 7 files
```
