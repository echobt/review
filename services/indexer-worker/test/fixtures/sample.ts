import { readFile } from "node:fs/promises";
import helper, { a, b as c } from "./util";

const LIMIT = 10;

export class Greeter extends Base {
  greet(name: string): string {
    return format(name, LIMIT);
  }

  shout(name: string) {
    return this.greet(name).toUpperCase();
  }
}

export function format(s: string, n: number) {
  return s.slice(0, n);
}

export const run = async () => {
  await readFile("x");
  return new Greeter();
};

interface Options { verbose: boolean }
type Id = string;
