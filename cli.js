#!/usr/bin/env node
const url = require("url");
const fs = require("fs");
const config = JSON.parse(fs.readFileSync(process.argv[2] || "config.json", 'utf8'));
const pathname = new url.URL(config.url).pathname.replace(/\/?$/, "/");
const app = require("./index")(config);

if (typeof config.listen === "object") {
    if (typeof config.listen.port === "undefined" && typeof config.listen.path === "string" ) {
        console.log(`Listening on ${config.listen.path} under path ${pathname}`);
        process.on("exit", () => fs.unlinkSync(config.listen.path));
        if (fs.existsSync(config.listen.path)) fs.unlinkSync(config.listen.path);
    } else {
        console.log(`Listening on ${config.listen.host || ""}:${config.listen.port} under path ${pathname}`);
    }
} else {
    console.log(`Listening on ${config.listen} under path ${pathname}`);
    if (typeof config.listen === "string" && isNaN(config.listen)){
        process.on("exit", () => fs.unlinkSync(config.listen));
        if (fs.existsSync(config.listen)) fs.unlinkSync(config.listen);
    }
}

app.listen(config.listen);