import { getNews } from '../getNews';

export async function GET() {
    return getNews();
}
