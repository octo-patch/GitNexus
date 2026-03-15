class User {
  constructor(name) {
    this.name = name;
  }

  save() {
    return true;
  }
}

class Repo {
  constructor(path) {
    this.path = path;
  }

  save() {
    return true;
  }
}

module.exports = { User, Repo };
