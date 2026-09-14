/**
 * Teach ream's `ContainerBindings` what `container.make(...)` returns for the
 * tokens prism binds.
 *
 * ream declares that interface open on purpose: it registers its own entries
 * and expects each package to contribute the ones it owns. Without this,
 * resolving by the string token answers `unknown` and every call site has to
 * assert a type it cannot prove.
 *
 * Type-only, and ream stays an OPTIONAL peer: nothing here reaches a runtime
 * import, and a `declare module` for a specifier that does not resolve is
 * simply inert.
 */

// Referenced so the augmentation below resolves the module it augments.
import type {} from "@c9up/ream/types";

import type { Prism } from "./Prism.js";

declare module "@c9up/ream/types" {
	interface ContainerBindings {
		/** The image engine, bound by `PrismProvider`. */
		"prism.images": Prism;
		/** The same binding under the bare role name. */
		images: Prism;
	}
}
