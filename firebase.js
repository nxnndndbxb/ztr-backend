const admin = require('firebase-admin');

// Your service account configuration
const serviceAccount = {
  type: "service_account",
  project_id: "fortune-2cb70",
  private_key_id: "92ab4f1de4b7a8ee49001afc479d16fbcb16ef0a",
  private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDSakGqrgmoEB+j
Bw25s85umkv7VE51balaSQBkqMmAP5T9ZZWJap/StRCwCT5s6x826MZqfWpmJfpi
ozybEeSr6bwcY6eLdwiKtvT1WngtsHjivCmymQ4yz0h3C19oBPQxBNBzF7uSr0WC
DOFJEVuf9OPtu6OuzUjYn4LgKWQFQJjgd5Gtc2Ly1A/G4A+08EyrBcYX/07xOt6O
iWKk8admuxcj7TxhJSn3ylw13KmtYisFbNevEGsq346ATPvEB/o5gn3jrkpAXKjj
jkExBdTWTgX9Pc15tpZ1niQwnZnSU7sQwVp8BT/cINGuLQPKnH5LastAIAmy5TrG
hApjaMZvAgMBAAECggEAFUlWl1O/+laXPMDr7It6KMpHQYfH4C1V4qJb/dLtf6Hv
CquKMzqsLH7Qz15ACHjI0Z8+42sIpojVCcGF0hI/VfzxYNXcD0ndfVsA8QlT+xtN
P3LVrRG60/0QUaq+3iESKxtXky0ldrNwjrWK3P96i3YU0OoYpwhxhCiu7sqBKd6u
AHoR03L4pUiEsVL3CSJuMl7Zuis3zHiUi0kdj2bbpvBFMvplVQw/cO4JcfJcTEWc
AHscjdnZqv1v9by056e6yUOvByrGF0W1UP9XbTRkY1np1WFfE2ZsrG47FrEH8v1u
yiVtDdi8r/ZW3gKXk85OzV3kr+RCO+kUAByJ7APeMQKBgQD6XASJ1h4OjmiJ83X4
hcmTt0qpMNGgSyOI9ciQFpwzcZ7UtDDPXjednKkhf4UEYhuvSEgOZDX4eXalBZqp
vWOahcT7uKllCwzo9dTk4XNW7Vi9ti0J2Hii73hHFVT23OgZy3YHmXhTV7aGK9UW
pay3MBipDvIlePEJYvksCv3yhQKBgQDXJ9qnj3vIrtHYsa4wWwkYD+Cj7gPT4hSD
3AdzUWMohEm9VH3I2max60BWILA2h4OigI53jSx6sSKtlbMRX/dzWyU1woqtX3vm
SDS/1RnOKAoCkiib6BONUpqlZFVuXik5pr5Xn66SwU5OvTWnjKdlCzsyG9QmyZ5S
jK6zFAEZYwKBgEmFqFeKJ72CmLSaaLSZJX9ZvnU9PvJh3oekFkgqO6jn3wr797GO
K6r/jLOnrTqCTTsGcRK43xifIvaHVMowMgX47sY1jpl7y0jGmMS2aJbIkNz1mPhh
N9wxkxLc8tykNw0MMRc+PJXNFm8EhEloUfZiC3vqRbY3dCGbjS0f9T+5AoGAYrBw
Nj21bLbroHbXzGxlfnkB9I+fh9gCyvzpGfcyAYq0fDi+PZwYUPH0n8z8pvZ/5dEM
CEBkL58CphatfYHEclBTgBZNH/tVTKrAL2HjJVHuTYGXSPQpy8AhGU4tdaORS1V1
p6GiJMSwU6Oscb8tpUaCj5h+NpByo7DODWxWmLsCgYB77ar2qS11ynItqKurFvRH
xVP8TO1qiM3UPx1ED4QzhrG+p8VAfzCJPPn8UkY4VcZhSzT6QptfTo3uO9dsvnzA
XqKOzvhdPx25qPhtasrMGb81BMIRiJszsoQqw50nVdcxi95OLE6cKBXHWBFnM7Bj
5/C/ZmsYg3aApcaelP4PLg==
-----END PRIVATE KEY-----\n`,
  client_email: "firebase-adminsdk-fbsvc@fortune-2cb70.iam.gserviceaccount.com",
  client_id: "102872628676620405811",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40fortune-2cb70.iam.gserviceaccount.com",
  universe_domain: "googleapis.com"
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://fortune-2cb70-default-rtdb.asia-southeast1.firebasedatabase.app/"
  });
}

const db = admin.database();

module.exports = { admin, db };