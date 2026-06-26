import { createServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const server = createServer();

server.listen(port, () => {
  console.log(`discourse-github-pr-bridge service listening on ${port}`);
});
