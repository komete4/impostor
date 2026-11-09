class Logger {
  /**
   * @param {boolean} debug - Print debug lines and attached objects
   * @param {string|null} prefix - Tag for every line, e.g. a bot id
   * @param {string[]} secrets - Exact values that must not appear in logs
   */
  constructor(debug = false, prefix = null, secrets = []) {
    this.debugMode = debug;
    this.prefix = prefix;
    this.secrets = secrets.filter((value) => typeof value === "string" && value.length > 0);
  }

  /** A logger that tags its lines, for one bot's output among several. */
  child(prefix) {
    return new Logger(this.debugMode, prefix, this.secrets);
  }

  formatMessage(level, message, obj) {
    const timestamp = new Date().toISOString();
    const tag = this.prefix ? ` [${this.prefix}]` : "";
    let formattedMessage = `[${timestamp}] [${level.toUpperCase()}]${tag} ${message}`;
    if (obj !== null && this.debugMode) {
      formattedMessage += `\n${JSON.stringify(obj, null, 2)}`;
    }
    for (const secret of this.secrets) {
      const jsonEscaped = JSON.stringify(secret).slice(1, -1);
      formattedMessage = formattedMessage.replaceAll(jsonEscaped, "[redacted]").replaceAll(secret, "[redacted]");
    }
    return formattedMessage;
  }

  debug(message, obj = null) {
    if (this.debugMode) {
      console.log(this.formatMessage("debug", message, obj));
    }
  }

  info(message, obj = null) {
    console.log(this.formatMessage("info", message, obj));
  }

  warn(message, obj = null) {
    console.warn(this.formatMessage("warn", message, obj));
  }

  error(message, obj = null) {
    console.error(this.formatMessage("error", message, obj));
  }
}

module.exports = Logger;
