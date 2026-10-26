import { imageSize, notebookImage } from "@/lib/search/notebook-image";

export const alt = "System Design Simulator — an engineer’s field notebook";
export const size = imageSize;
export const contentType = "image/png";

export default function Image() {
  return notebookImage("Learn system design by running it.", "Draw an architecture, run it against real traffic, then break it on purpose.", "Field notebook", true);
}
