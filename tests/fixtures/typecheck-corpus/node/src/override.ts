// noImplicitOverride and parameter properties.
class Base {
	constructor(protected readonly name: string) {}
	greet(): string {
		return this.name;
	}
}
export class Implicit extends Base {
	greet(): string {
		return "implicit";
	}
}
export class Explicit extends Base {
	override greet(): string {
		return "explicit";
	}
	override wave(): string {
		return this.name;
	}
}
