export interface MdNode { type: string; text?: string; href?: string; start?: number; children?: MdNode[]; items?: MdNode[][] }
export function parseComment(src: string): MdNode[];
export function commentText(src: string | MdNode[]): string;
