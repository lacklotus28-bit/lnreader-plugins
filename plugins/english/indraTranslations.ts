import { load } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';

class IndraTranslations implements Plugin.PluginBase {
  id = 'indratranslations';
  name = 'Indra Translations';
  site = 'https://indratranslations.com';
  version = '1.3.0';
  icon = 'src/en/indratranslations/icon.png';
  // customCSS = 'src/en/indratranslations/customCSS.css';
  // (optional) Add these files to the repo and uncomment the lines above if you want an icon/custom CSS.

  // Browser-like headers (important for Cloudflare-y sites)
  private headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    Referer: this.site,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };

  private async fetchHtml(url: string): Promise<string> {
    const res = await fetchApi(url, { headers: this.headers });
    return await res.text();
  }

  private absolute(url?: string): string | undefined {
    if (!url) return undefined;
    const u = String(url).trim();
    if (!u) return undefined;
    if (u.startsWith('http')) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/')) return this.site + u;
    return this.site + '/' + u;
  }

  private clean(text: unknown): string {
    return String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private chapterNum(name: string): number {
    const m = String(name).match(/(\d+(\.\d+)?)/);
    return m ? Number(m[1]) : 0;
  }

  /**
   * The site's series list ("Novels" page) renders each result as a
   * <div class="series-card" onclick="location.href='...'"> — there is
   * no real <a href> to select. Extract the destination from the
   * onclick attribute instead.
   */
  private parseNovelCards($: ReturnType<typeof load>) {
    const out: { name: string; path: string; cover?: string }[] = [];
    const seen = new Set<string>();

    $('.series-card').each((_, el) => {
      const card = $(el);
      const onclick = card.attr('onclick') || '';
      const match = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
      const href = match ? match[1] : '';
      if (!href) return;

      const cleanPath = href.replace(this.site, '').trim();
      if (!cleanPath) return;

      const normalized = cleanPath.endsWith('/') ? cleanPath : cleanPath + '/';
      if (seen.has(normalized)) return;

      const name = this.clean(card.find('.series-card-title').text());
      if (!name) return;

      const cover = this.absolute(
        card.find('.series-card-cover img').attr('src'),
      );

      seen.add(normalized);
      out.push({ name, path: normalized, cover });
    });

    return out;
  }

  async popularNovels(pageNo: number) {
    const url =
      pageNo > 1
        ? `${this.site}/series/?orderby=views&paged=${pageNo}`
        : `${this.site}/series/?orderby=views`;
    const html = await this.fetchHtml(url);
    const $ = load(html);
    return this.parseNovelCards($);
  }

  async searchNovels(searchTerm: string, pageNo: number) {
    if (pageNo !== 1) return [];
    const url = `${this.site}/series/?keyword=${encodeURIComponent(searchTerm)}`;
    const html = await this.fetchHtml(url);
    const $ = load(html);
    return this.parseNovelCards($);
  }

  async parseNovel(novelPath: string) {
    const url = novelPath.startsWith('http')
      ? novelPath
      : this.site + novelPath;
    const html = await this.fetchHtml(url);
    const $ = load(html);

    const title =
      this.clean($('.story-main-title').first().text()) ||
      this.clean($('h1').first().text()) ||
      'Unknown';

    const cover = this.absolute(
      $('.story-covers-swiper img').first().attr('src') ||
        $('.story-cover-card img').first().attr('src'),
    );

    const summary = this.clean($('#story-synopsis').text()) || undefined;

    const statusText = this.clean($('a[href*="/trang-thai/"]').first().text());

    const genres: string[] = [];
    $('a[href*="/series-genre/"]').each((_, el) => {
      const g = this.clean($(el).text());
      if (g) genres.push(g);
    });

    const chapters: { name: string; path: string; chapterNumber?: number }[] =
      [];

    // The chapter list is embedded as inline JSON in a <script> tag
    // (var TD_Story_Chapters = [...]) rather than rendered as plain
    // <a> links in a static list — this is the modern replacement for
    // the old .wp-manga-chapter markup.
    const scriptMatch = html.match(
      /var\s+TD_Story_Chapters\s*=\s*(\[[\s\S]*?\]);/,
    );

    if (scriptMatch) {
      try {
        const raw = JSON.parse(scriptMatch[1]) as Array<{
          num?: number;
          title?: string;
          link?: string;
          vip?: number;
        }>;
        for (const c of raw) {
          if (!c.link) continue;
          // Skip VIP/paid chapters — vip may come through as either
          // the number 1 or the string "1" depending on how the site
          // serialized this particular novel's chapter data, so check
          // loosely rather than strictly for the number 1.
          if (c.vip == 1) continue;
          const name = this.clean(c.title) || `Chapter ${c.num ?? ''}`;
          chapters.push({
            name,
            path: c.link.replace(this.site, ''),
            chapterNumber: c.num ?? this.chapterNum(name),
          });
        }
      } catch {
        // fall through to DOM fallback below
      }
    }

    // Fallback: parse the rendered chapter list DOM if the script
    // extraction failed for any reason (theme change, minification, etc).
    if (chapters.length === 0) {
      $('.chap-item').each((_, el) => {
        const a = $(el);
        const href = a.attr('href');
        if (!href) return;
        const name = this.clean(a.find('span').first().text());
        chapters.push({
          name,
          path: href.replace(this.site, ''),
          chapterNumber: this.chapterNum(name),
        });
      });
    }

    chapters.sort((a, b) => (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0));

    const statusLower = statusText.toLowerCase();
    const status = statusLower.includes('complete')
      ? NovelStatus.Completed
      : statusLower.includes('drop')
        ? NovelStatus.Cancelled
        : NovelStatus.Ongoing;

    return {
      name: title,
      path: novelPath.endsWith('/') ? novelPath : novelPath + '/',
      cover,
      summary,
      status,
      genres: genres.length ? genres.join(', ') : undefined,
      chapters,
    };
  }

  async parseChapter(chapterPath: string) {
    const url = chapterPath.startsWith('http')
      ? chapterPath
      : this.site + chapterPath;
    const html = await this.fetchHtml(url);
    const $ = load(html);

    const content = $('#chapter-content-text').first();

    if (!content.length) {
      return `\nUnable to load chapter content.\n\n`;
    }

    // The site injects hidden "noise" spans (class="td-s-noise",
    // display:none) containing random junk characters between words
    // in every paragraph, specifically to poison scrapers. These must
    // be stripped before reading the content, or the extracted text
    // comes out garbled with random strings mixed into every sentence.
    content
      .find(
        '.td-s-noise, script, style, ins, iframe, noscript, .td-ad-container',
      )
      .remove();

    return content.html() ?? '';
  }

  filters: Filters = {
    sort: {
      label: 'Sort',
      value: 'views',
      options: [
        { label: 'Newest', value: 'new' },
        { label: 'Recently Updated', value: 'update' },
        { label: 'Most Viewed', value: 'views' },
        { label: 'Highest Rated', value: 'rating' },
        { label: 'Most Chapters', value: 'chapters' },
      ],
      type: FilterTypes.Picker,
    },
  };
}

export default new IndraTranslations();
