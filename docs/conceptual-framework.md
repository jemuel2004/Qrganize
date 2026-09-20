# Conceptual Framework

Input–Process–Output (IPO) model of the study.  
**SOFTWARE / TECHNOLOGY STACK** under INPUT is based on technologies confirmed in the QRganize codebase (`package.json` and source implementation).  
PROCESS and OUTPUT sections are unchanged from the study framework.

---

## INPUT

**Data Requirements:**
- Faculty Profiles and Teaching Loads
- Academic Designations
- Program Requirements and Class Schedules
- Room Utilization Data

**SOFTWARE / TECHNOLOGY STACK:**
- **Programming Language:**
  - TypeScript
  - JavaScript
- **Frontend:**
  - Next.js
  - React
  - Tailwind CSS
- **Backend / API:**
  - Next.js API Routes (Node.js)
- **Database:**
  - PostgreSQL
- **Authentication / Security:**
  - bcryptjs
  - JWT (jose)
  - Google OAuth (google-auth-library)
  - Nodemailer (Email OTP)
- **Libraries / Tools:**
  - qrcode
  - html5-qrcode
  - Recharts
  - lucide-react
  - xlsx
  - uuid
- **Development Tools:**
  - Visual Studio Code
  - Node.js

**HARDWARE:**
- Workstation/Laptop

---

## PROCESS

- Agile Model
- **Modelling Tools:**
  - Deployment Diagram
  - Use-case Diagram
  - Requirement Analysis
- **System Validation:**
  - Use-case Diagram

---

## OUTPUT

QRGanize: QR-Based Room Scheduler & Monitoring System based on Programs & Instructors' Workload

---

## Notes (for documentation only; not part of the diagram)

| Item | Confirmation |
|------|----------------|
| Backend | Next.js App Router route handlers under `src/app/api/` — **not** Express.js |
| Database | PostgreSQL via `pg` and `DATABASE_URL` |
| Auth | Password hashing (`bcryptjs`), session JWT (`jose`), Google ID token verify, email OTP (`nodemailer`) |
| QR | Generation (`qrcode`); camera/upload scanning (`html5-qrcode`) |
| Uploads | Local filesystem (`fs`) + path stored in PostgreSQL |
| Not included | Express.js, Git (no repository marker in this project tree) |
