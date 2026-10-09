require('dotenv').config();

const readline = require('readline');
const { hashPassword } = require('../utils/crypto');
const pool = require('../db/pool');

function prompt(question) {
  return new Promise((resolve) => {
    const terminal = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    terminal.question(question, (answer) => {
      terminal.close();
      resolve(answer);
    });
  });
}

function promptPassword(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      reject(new Error('Run this command in an interactive terminal.'));
      return;
    }

    let value = '';
    const finish = (error) => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        finish(new Error('Cancelled.'));
      } else if (key.name === 'return' || key.name === 'enter') {
        finish();
      } else if (key.name === 'backspace') {
        value = value.slice(0, -1);
      } else if (character && !key.ctrl && !key.meta) {
        value += character;
      }
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKeypress);
    process.stdout.write(question);
  });
}

async function main() {
  if (!process.env.DATABASE_URL || !process.env.PEPPER) {
    throw new Error('DATABASE_URL and PEPPER must be set in .env.');
  }

  const username = (await prompt('Username (3-50 letters, numbers, underscores): ')).trim();
  if (!/^[a-zA-Z0-9_]{3,50}$/.test(username)) {
    throw new Error('Username must be 3-50 letters, numbers, or underscores.');
  }

  const email = (await prompt('Email: ')).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }

  const role = (await prompt('Role (admin/editor/student) [admin]: ')).trim() || 'admin';
  if (!['admin', 'editor', 'student'].includes(role)) {
    throw new Error('Role must be admin, editor, or student.');
  }

  const password = await promptPassword('Password (6-128 characters): ');
  if (password.length < 6 || password.length > 128) {
    throw new Error('Password must be 6-128 characters.');
  }

  const { hash, salt } = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (username, email, password_hash, salt, role)
     VALUES ($1, $2, $3, $4, $5)`,
    [username, email, hash, salt, role]
  );

  console.log(`Created ${role} user "${username}".`);
}

main()
  .catch((error) => {
    console.error(`Could not create user: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
