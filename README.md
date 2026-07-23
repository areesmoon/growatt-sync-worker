# Growatt Sync Worker

A Node.js background worker designed to periodically fetch telemetry data from Growatt solar inverters, calculate accurate slave battery capacity using an Ah Counting & Master-Guided Control algorithm, and seamlessly synchronize the data to Firebase Firestore.

---

## 🚀 Key Features

* **Automated Sync:** Built to run periodically (e.g., via a Cron Job every 5 minutes).
* **Ah Counting & Correction:** Accurately tracks slave battery SOC changes with proportional correction guidance from the master battery's SOC.
* **Deduplication Check:** Prevents duplicate logs by checking the inverter's timestamp before inserting new records.
* **Secure Firebase Admin Integration:** Safely writes telemetry data directly to Firestore using the Firebase Admin SDK.

---

## ⚙️ System Requirements

* Node.js (Version 18+ recommended)
* A VPS or local server environment
* A Firebase project with Firestore enabled

---

## 📦 Installation & Configuration

1. **Clone the Repository**
```bash
git clone https://github.com/areesmoon/growatt-sync-worker.git
cd growatt-sync-worker

```


2. **Install Dependencies**
```bash
npm install

```


3. **Set Up Secret Configuration Files**
This project requires two sensitive files in the root directory that must **never** be pushed to GitHub (already handled in `.gitignore`):
* **`.env.local`** (For Growatt credentials)
Create a file named `.env.local` and add your credentials:
```env
GROWATT_USERNAME=your_growatt_username
GROWATT_PASSWORD=your_growatt_password

```


* **`serviceAccountKey.json`** (For Firebase Admin access)
* Go to the **Firebase Console** and select your project.
* Navigate to **Project Settings > Service accounts**.
* Click **Generate new private key** and download the JSON file.
* Place the downloaded file into the root folder of this project and rename it to **`serviceAccountKey.json`**.





---

## 🏃‍♂️ How to Run

* **Manual Execution (Dry Run / Test):**
```bash
node index.js

```


* **Automating on a VPS (Cron Job):**
Open your crontab configuration:
```bash
crontab -e

```


Add the following line to run the script automatically every 5 minutes:
```bash
*/5 * * * * /usr/bin/node /path/to/growatt-sync-worker/index.js >> /path/to/growatt-sync-worker/sync.log 2>&1

```



---

## 🛡️ License

MIT License