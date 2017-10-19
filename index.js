const config = require(process.argv[2] || "./config.json");
const _ = require("lodash");
const express = require("express");
const compression = require("compression");
const basicAuth = require("express-basic-auth");
const bb = require("express-busboy");
const handlebars = require("express-handlebars");
const promBundle = require("express-prom-bundle");
const helpers = require("handlebars-helpers")();
const dateformat = require("helper-dateformat");
const Paginator = require("paginator");
let paginator = new Paginator(48, 8);
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const glob = require("glob");
const url = require("url");
const util = require("util");
const Highlights = require("highlights");
const highlighter = new Highlights();
const sanitizeFilename = require("sanitize-filename");
const CodeRain = require("coderain");
let cr = new CodeRain(("#").repeat(config.fileLength || 4));

let app = express();
let statCache = {};

app.engine(".hbs", handlebars({ defaultLayout: "main", extname: ".hbs", helpers: _.merge(helpers, { "dateformat" : dateformat }) }));
app.set("view engine", ".hbs");
app.use(express.static("public"));
app.use(express.static(config.imagePath));
// app.use(compression());

bb.extend(app, {
	upload: true
});

let auth = basicAuth({
	authorizer: (user, pass) => crypto.createHash("sha256").update(pass).digest("hex") === config.password,
	challenge: true,
	realm: config.url
});

function error(req, res, error) {
	if (req.xhr || req.headers.accept.indexOf('json') > -1) {
		res.json({ ok: false, error });
	} else {
		res.render("error", { error });
	}
}

function moveFile(oldPath, newPath, callback) {
	fs.rename(oldPath, newPath, function (err) {
		if (err) {
			if (err.code === "EXDEV") {
				copy();
			} else {
				callback(err);
			}
			return;
		}
		callback();
	});

	function copy() {
		var readStream = fs.createReadStream(oldPath);
		var writeStream = fs.createWriteStream(newPath);

		readStream.on("error", callback);
		writeStream.on("error", callback);

		readStream.on("close", function () {
			fs.unlink(oldPath, callback);
		});

		readStream.pipe(writeStream);
	}
}

app.use(promBundle({
	includeMethod: true,
	includePath: true,
	normalizePath: (req, opts) => {
		return url.parse(req.originalUrl).pathname;
	}
}));

app.get("/", (req, res) => {
	res.render("home", {config: _.omit(config, "password")});
});

app.get("/upload", (req, res) => {
	res.render("upload", {config: _.omit(config, "password")});
});

app.post("/upload", (req, res) => {
	if (!req.files || !req.files.file) return error(req, res, "No file specified.");
	if (!req.body.password) return error(req, res, "No password specified.");
	if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");

	let file = req.files.file;
	let ext = req.query.ext ? sanitizeFilename(req.query.ext) : path.extname(file.filename);

	if (ext.toLowerCase() === ".php") return error(req, res, "Disallowed file type.");

	let name;
	let attempts = 0;

	do {
		if (attempts === 0 && req.body.name && req.body.name.length > 0) {
			name = req.body.name.replace(/[^A-Za-z0-9_\-]/g, "_");
		} else {
			name = cr.next();
		}

		attempts++;

		if (attempts > 20) {
			return error(req, res, "Could not generate unique filename after 20 attempts.");
		}
	} while (fs.existsSync(`${config.imagePath}/${name}${ext}`));

	moveFile(file.file, `${config.imagePath}/${name}${ext}`, err => {
		if (err) {
			return console.error(util.inspect(err, { depth: null }));
		}

		if (typeof req.query.paste !== "undefined") {
		  name = "paste/" + name;
    }

		if (req.body.online === "yes") {
			res.redirect(`${config.url}${name}${ext}`);
		} else {
			res.json({
				ok: true,
				url: `${config.url}${name}${ext}`
			});
		}
	});
});

app.get("/paste/:file", (req, res) => {
	let filename = sanitizeFilename(req.params.file);
	let filePath = path.join(config.imagePath, filename);

  if (!filePath) return res.status(404).send("File not found");

	fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return res.status(404).send("File not found");

    let html = highlighter.highlightSync({ filePath });

    res.render("paste", {
      paste: html,
      style: config.pasteThemePath || "https://atom.github.io/highlights/examples/atom-dark.css",
      name: filename,
      layout: false
    });

    fs.readFile(filePath, "utf8", (err, data) => {
      if (err) return res.status(404).send("File not found");
    });
  });
});

app.get("/gallery/:page?", auth, (req, res) => {
	glob("*.{jpg,png,gif,jpeg}", { cwd: config.imagePath }, (err, files) => {
		let page = typeof req.params.page !== "undefined" ? parseInt(req.params.page) : 0;
		page = Math.min(Math.max(0, page), files.length);

		let paginationInfo = paginator.build(files.length, page);

		let fullFiles = _.reverse(_.sortBy(_.map(files, f => {
			if (statCache[f]) {
				return statCache[f];
			} else {
				let stat = fs.statSync(`${config.imagePath}/${f}`);
				let o = {
					name: f,
					size: stat.size,
					mtime: stat.mtime
				};
				statCache[f] = o;
				return o;
			}
		}), "mtime"));

		res.render("gallery", {
			paginationInfo,
			pages: _.range(paginationInfo.first_page, paginationInfo.last_page),
			files: _.slice(fullFiles, paginationInfo.first_result, paginationInfo.last_result + 1)
		});
	});
});

app.get("/list/:page?", auth, (req, res) => {
	glob("*.*", { cwd: config.imagePath }, (err, files) => {
		let page = typeof req.params.page !== "undefined" ? parseInt(req.params.page) : 0;
		page = Math.min(Math.max(0, page), files.length);

		let paginationInfo = paginator.build(files.length, page);

		let fullFiles = _.reverse(_.sortBy(_.map(files, f => {
			if (statCache[f]) {
				return statCache[f];
			} else {
				let stat = fs.statSync(`${config.imagePath}/${f}`);
				let o = {
					name: f,
					size: stat.size,
					mtime: stat.mtime
				};
				statCache[f] = o;
				return o;
			}
		}), "mtime"));

		res.render("list", {
			paginationInfo,
			pages: _.range(paginationInfo.first_page, paginationInfo.last_page),
			files: _.slice(fullFiles, paginationInfo.first_result, paginationInfo.last_result + 1)
		});
	});
});

app.listen(config.listen);
