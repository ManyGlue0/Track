export const spring = { type: "spring", stiffness: 520, damping: 38, mass: 0.8 } as const;
export const softSpring = { type: "spring", stiffness: 300, damping: 30 } as const;
export const rowSpring = { type: "spring", stiffness: 520, damping: 34 } as const;
export const pageSpring = { type: "spring", stiffness: 420, damping: 40 } as const;
export const reveal = { duration: 0.32, ease: [0.16, 1, 0.3, 1] } as const;
export const conceal = { duration: 0.09, ease: "easeIn" } as const;
export const sheetSpring = { type: "spring", stiffness: 420, damping: 38 } as const;
