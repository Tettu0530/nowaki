// Asset import demo. photo.png is optimized automatically at build time (lossless PNG recompression).
import photo from "../photo.png";

export default function Photo() {
  return <img src={photo} width="128" height="128" alt="demo" data-testid="photo" />;
}
