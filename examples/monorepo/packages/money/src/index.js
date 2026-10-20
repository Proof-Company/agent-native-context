// Money is integer cents. Floating-point dollars never enter this module.
export function addCents(a, b) {
    if (!Number.isInteger(a) || !Number.isInteger(b))
        throw new TypeError("amounts must be integer cents");
    return a + b;
}
