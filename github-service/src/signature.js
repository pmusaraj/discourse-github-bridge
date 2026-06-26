import crypto from "node:crypto";

export function signDiscourseRequest({ body, timestamp, secret }) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
