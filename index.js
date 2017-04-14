const config = require("./config.json");
const _ = require("lodash");
const express = require("express");
const compression = require("compression");
const basicAuth = require("express-basic-auth");
const bb = require("express-busboy");
const handlebars = require("express-handlebars");
const helpers = require("handlebars-helpers")();
const dateformat = require("helper-dateformat");
const Paginator = require("paginator");
let paginator = new Paginator(48, 8);
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const glob = require("glob");
const CodeRain = require("coderain");
let cr = new CodeRain("####");

let app = express();
let statCache = {};

app.engine(".hbs", handlebars({ defaultLayout: "main", extname: ".hbs", helpers: _.merge(helpers, { "dateformat" : dateformat }) }));
app.set("view engine", ".hbs");
app.use(express.static("public"));
app.use(express.static("/var/www-ichi/src"));
// app.use(compression());

bb.extend(app, {
	upload: true
});

let auth = basicAuth({
	authorizer: (user, pass) => crypto.createHash("sha256").update(pass).digest("hex") === config.password,
	challenge: true,
	realm: "shitty.download"
});

function error(req, res, error) {
	if (req.xhr || req.headers.accept.indexOf('json') > -1) {
		res.json({ ok: false, error });
	} else {
		res.render("error", { error });
	}
}

app.get("/", (req, res) => {
	res.render("home");
});

app.get("/upload", (req, res) => {
	res.render("upload");
});

app.post("/upload", (req, res) => {
	if (!req.files || !req.files.file) return error(req, res, "No file specified.");
	if (!req.body.password) return error(req, res, "No password specified.");
	if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");

	let file = req.files.file;
	let ext = path.extname(file.filename);

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
	} while (fs.exists(`/var/www-ichi/src/${name}${ext}`));

	fs.rename(file.file, `/var/www-ichi/src/${name}${ext}`, () => {
		let baseURL = req.protocol + '://' + req.get('host');

		if (req.body.online === "yes") {
			res.redirect(`https://shitty.download/${name}${ext}`);
		} else {
			res.json({
				ok: true,
				url: `https://shitty.download/${name}${ext}`
			});
		}
	});
});

app.get("/gallery/:page?", auth, (req, res) => {
	glob("*.{jpg,png,gif,jpeg}", { cwd: "/var/www-ichi/src" }, (err, files) => {
		let page = typeof req.params.page !== "undefined" ? parseInt(req.params.page) : 0;
		page = Math.min(Math.max(0, page), files.length);

		let paginationInfo = paginator.build(files.length, page);

		let fullFiles = _.reverse(_.sortBy(_.map(files, f => {
			if (statCache[f]) {
				return statCache[f];
			} else {
				let stat = fs.statSync(`/var/www-ichi/src/${f}`);
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
	glob("*.*", { cwd: "/var/www-ichi/src" }, (err, files) => {
		let page = typeof req.params.page !== "undefined" ? parseInt(req.params.page) : 0;
		page = Math.min(Math.max(0, page), files.length);

		let paginationInfo = paginator.build(files.length, page);

		let fullFiles = _.reverse(_.sortBy(_.map(files, f => {
			if (statCache[f]) {
				return statCache[f];
			} else {
				let stat = fs.statSync(`/var/www-ichi/src/${f}`);
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

app.listen("4109");
