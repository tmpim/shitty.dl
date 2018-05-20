const CodeRain = require("coderain");
const cr = new CodeRain(("#").repeat(4));

module.exports = () => {
	return (new Date().getTime()) + "-" + cr.next();
};