export interface Photo {
  id: string;
  large: string;
  thumbnail: string;
  width: number;
  height: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
}

export interface Placement {
  imageId: string;
  title: string;
  caption: string;
  alt: string;
  tags: string[];
}

export interface PortfolioPage {
  slug: string;
  title: string;
  kind: 'gallery' | 'about' | 'contact';
  description: string;
  bodyHtml: string;
  placements: Placement[];
}

export interface SiteContent {
  name: string;
  description: string;
  email: string;
  phone: string;
  instagram: string;
  pages: PortfolioPage[];
  photos: Record<string, Photo>;
}
