const config = require(process.argv[2] || "./config.json");

const _ = require("lodash");

const fs = require("fs");
const path = require("path");
const url = require("url");
const util = require("util");

const express = require("express");
const router = express.Router();
const bb = require("express-busboy");
const handlebars = require("express-handlebars");
const promBundle = require("express-prom-bundle");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const helpers = require("handlebars-helpers")();
const dateformat = require("helper-dateformat");
const Finder = require("fs-finder");
const moment = require("moment");

const paginator = new require("paginator")(48, 8);
const crypto = require("crypto");
const Highlights = require("highlights");
const highlighter = new Highlights({ scopePrefix: config.oldPasteThemeCompatibility ? "" : "syntax--" });
const sanitizeFilename = require("sanitize-filename");
const CodeRain = require("coderain");
const cr = new CodeRain(("#").repeat(config.fileLength || 4));
const filesize = require("filesize");

const readChunk = require('read-chunk');
const fileType = require('file-type');

const app = express();
let statCache = {};

if (fs.existsSync("stats.json")) {
	statCache = JSON.parse(fs.readFileSync("stats.json"));
	for (var key in statCache) {
		if (!statCache.hasOwnProperty(key)) continue;
		if (!key.mtimeSave) {delete statCache[key]; continue;};
		key.mtime = new Date(key.mtimeSave);
	};
}

const pathname = new url.URL(config.url).pathname.replace(/\/?$/, "/");

if (!config.sessionSecret) {
	console.error("Please put a secure random value in config.sessionSecret");
	process.exit(0);
}

if (config.languagePackages) {
  config.languagePackages.forEach(package => {
    try {
      const pkg = require.resolve(`${package}/package.json`);
      highlighter.requireGrammarsSync({ modulePath: pkg });
    } catch (e) {
      console.warn(`Could not find/load language package ${package}`)
    }
  });
} 

app.engine(".hbs", handlebars({ defaultLayout: "main", extname: ".hbs", helpers: _.merge(helpers, { "dateformat" : dateformat }) }));
app.set("view engine", ".hbs");
app.use(session({
	secret: config.sessionSecret,
	cookie: {},
	resave: false,
	saveUninitialized: true,
	store: new SQLiteStore
}));

bb.extend(app, {
	upload: true
});

function error(req, res, error) {
	console.error(util.inspect(error, {
		depth: null,
		colors: true,
		showHidden: true
	}));

	if (req.xhr || req.headers.accept.indexOf('json') > -1) {
		res.json({ ok: false, error });
	} else {
		res.render("error", { errorText: error });
	}
}

function moveFile(oldPath, newPath, callback) {
	fs.rename(oldPath, newPath, err => {
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
		const readStream = fs.createReadStream(oldPath);
		const writeStream = fs.createWriteStream(newPath);

		readStream.on("error", callback);
		writeStream.on("error", callback);

		readStream.on("close", () => fs.unlink(oldPath, callback));

		readStream.pipe(writeStream);
	}
}

app.use(promBundle({
	includeMethod: true,
	includePath: true,
	normalizePath: req => {
		return url.parse(req.originalUrl).pathname;
	}
}));

function auth(req, res, next) {
	if (!req.session || !req.session.authed) {
		return res.redirect(pathname);
	}

	next();
}

router.use(express.static("public"));
router.use(express.static(config.imagePath));

router.get(["/", "/home"], (req, res) => {
	res.render("home", {
		config: _.omit(config, ["password", "sessionSecret"]),
		authed: req.session && req.session.authed,
		pathname
	});
});

router.post("/login", (req, res) => {
	if (!req.body.password) return error(req, res, "No password specified.");
	if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");

	req.session.authed = true;
	req.session.save();

	res.redirect(pathname+"gallery");
});

router.get("/upload", auth, (req, res) => {
	res.render("upload", {
		config: _.omit(config, ["password", "sessionSecret"]),
		pageTemplate: "upload",
		pathname
	});
});

router.post("/upload", (req, res) => {
	if ( typeof req.body.link === "undefined" && (!req.files || !req.files.file)) return error(req, res, "No file/URL specified.");

	if (!req.session || !req.session.authed) {
		if (!req.body.password) return error(req, res, "No password specified.");
		if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");
	}

	let ext = "";
	if ( req.body.link ) {ext = ""}
	else if ( req.query.ext ) { ext = sanitizeFilename(req.query.ext) }
	else if ( path.extname(req.files.file.filename) != "" ) { ext = path.extname(req.files.file.filename) }
	else {
		const exten = fileType(readChunk.sync( req.files.file.file , 0, 4100));
		if (exten) ext = "." + exten.ext
	}

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

	if ( req.body.link ) {
		fs.writeFile( `${config.imagePath}/${name}` , req.body.link, (err) => {
			if (err) return console.log(JSON.stringify(err));
			name = "l/" + name; 
			res.json({
				ok: true,
				url: `${config.url.replace(/\/?$/, "/")}${name}`
			});
		});
	}
	else {
		moveFile( req.files.file.file, `${config.imagePath}/${name}${ext}`, err => {
			if (err) return console.log(JSON.stringify(err));

			if (typeof req.query.paste !== "undefined") {
				name = "paste/" + name;
			}

			if (req.body.online === "yes") {
				res.redirect(`${config.url}${name}${ext}`);
			} else {
				res.json({
					ok: true,
					url: `${config.url.replace(/\/?$/, "/")}${name}${ext}`
				});
			}
		});
	}
});

router.get("/paste/:file", (req, res) => {
	const filename = sanitizeFilename(req.params.file);
	const filePath = path.join(config.imagePath, filename);

	if (!filePath) return res.status(404).send("File not found");

	try {
		const stats = fs.statSync(filePath);

		console.log(stats);

		if (!stats.isFile()) return res.status(404).send("File not found");
		if (stats.size > 2 ** 19) return error(req, res, `File too large (${filesize(stats.size)})`);

		const html = highlighter.highlightSync({filePath});

		res.render("paste", {
			paste: html,
			style: config.pasteThemePath || "https://atom.github.io/highlights/examples/atom-dark.css",
			name: filename,
			pathname,
			layout: false
		});
	} catch (err) {
		error(req, res, err);
	}
});

router.get("/l/:file", (req, res) => {
	const filename = sanitizeFilename(req.params.file);
	const filePath = path.join(config.imagePath, filename);

	if (!filePath) return res.status(404).send("File not found");
	if (path.extname(filePath)) return error(req, res, "URL not valid");
	
	try {
		const stats = fs.statSync(filePath);

		if (!stats.isFile()) return res.status(404).send("File not found");
		if (stats.size > 1024) return error(req, res, `URL too large (${filesize(stats.size)})`);

		res.redirect(fs.readFileSync(filePath, { encoding: "utf8" }).trim());

	} catch (err) {
		error(req, res, err);
	}
});

function fileListing(mask, pageTemplate, route, req, res) {
	if (req.query.extensions) {
		mask = `*.<(${req.query.extensions.split(",").join("|")})$>`;
	}

	const finder = Finder.from(config.imagePath);
	if (req.query.start) finder.date(">", moment(new Date(req.query.start)).set({hours: 0, minutes: 0, seconds: 0, milliseconds: 0}).toISOString());
	if (req.query.end) finder.date("<", moment(new Date(req.query.end)).set({hours: 0, minutes: 0, seconds: 0, milliseconds: 0}).add(1, "day").toISOString());
	if (pageTemplate == "links") finder.size('<=', 1024);
	const files = finder.findFiles(mask);

	let page = typeof req.params.page !== "undefined" ? parseInt(req.params.page) : 0;
	page = Math.min(Math.max(0, page), files.length);

	const paginationInfo = paginator.build(files.length, page);

	const fullFiles = _.reverse(_.sortBy(_.map(files, f => {
		if (statCache[f]) return statCache[f];

		console.log(f);

		const stat = fs.statSync(`${f}`);
		const o = {
			name: path.relative(config.imagePath, f),
			size: stat.size,
			mtime: stat.mtime,
			mtimeSave: stat.mtime.toString(),
			c: (pageTemplate == "links" ? fs.readFileSync(`${f}`, { encoding: "utf8" }).trim() : undefined) /* undefined is not saved into JSON */
		};

		statCache[f] = o;

		return o;
	}), "mtime"));

	fs.writeFile("stats.json", JSON.stringify(statCache), () => {});

	res.render(pageTemplate, {
		route,
		pageTemplate,
		query: url.parse(req.url).query,
		paginationInfo,
		pages: _.range(paginationInfo.first_page, paginationInfo.last_page + 1),
		files: _.slice(fullFiles, paginationInfo.first_result, paginationInfo.last_result + 1),
		pathname
	});
}

router.get("/gallery/:page?", auth, (req, res) => fileListing("*.<(jpeg|jpg|png|gif)$>", "gallery", pathname+"gallery", req, res));
router.get("/list/:page?", auth, (req, res) => fileListing("*.*", "list", pathname+"list", req, res));
router.get("/links/:page?", auth, (req, res) => fileListing("<^[0-9a-zA-Z/-_ ]+$>", "links", pathname+"links", req, res));

console.log(`Listening on ${config.listen} under path ${pathname}`);

app.use(pathname, router);
app.listen(config.listen);
