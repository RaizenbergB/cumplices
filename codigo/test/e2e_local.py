"""Modo um celular só, do começo ao fim, no navegador. Também confere a versão para o Claude (sem modo online)."""
import os
import sys

from playwright.sync_api import sync_playwright

SITE = os.environ.get('SITE', 'http://127.0.0.1:8080/')
SHOTS = os.environ.get('SHOTS', '/tmp/claude-0/shots')
ARTIFACT = os.environ.get('ARTIFACT', '/home/claude/cumplices/dist/artifact/cumplices.html')
os.makedirs(SHOTS, exist_ok=True)
errors = []


def log(*a):
    print(*a, flush=True)


def no_overflow(page, where):
    w = page.evaluate('() => [document.documentElement.scrollWidth, window.innerWidth]')
    assert w[0] <= w[1], f'rolagem lateral em {where}: {w}'


def shot(page, name):
    no_overflow(page, name)
    page.screenshot(path=f'{SHOTS}/{name}.png', full_page=True)


def hold(page):
    btn = page.locator('.hold').first
    box = btn.bounding_box()
    page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    page.mouse.down()
    card = page.locator('[data-hold-show="papel"]:not([hidden]) .role-card').first
    card.wait_for(state='visible', timeout=5000)
    return card.inner_text()


def release(page):
    page.mouse.up()
    page.wait_for_timeout(80)
    assert page.locator('[data-hold-show="papel"]:not([hidden])').count() == 0


def mark_all(page, plan):
    for name, opt in plan.items():
        page.click(f'.entry-row:has(.nm:text-is("{name}")) button.vb[data-opt="{opt}"]')


def run_local(page, names, prefix, training=True, can_reload=True):
    page.click('text=Jogar com um celular só')
    page.wait_for_selector('text=Quem vai jogar')
    while page.locator('input[data-local-name]').count() < len(names):
        page.click('text=+ Adicionar jogador')
    for i, nm in enumerate(names):
        page.fill(f'#nome-{i}', nm)
    if training:
        page.check('#um-treino')
    shot(page, f'{prefix}20-um-config')
    page.click('text=Sortear papéis')
    roles = {}
    for i, nm in enumerate(names):
        page.wait_for_selector(f'text=Sou {nm}')
        if i == 0:
            shot(page, f'{prefix}21-um-passar')
        page.click(f'text=Sou {nm}')
        roles[nm] = hold(page)
        release(page)
        page.click('button[data-a="passar"]')
    cumplices = [n for n in names if 'parceiro' in roles[n].lower()]
    assert len(cumplices) == 2, roles
    a, b = cumplices
    dets = [n for n in names if n not in cumplices]
    log(prefix, 'cúmplices:', cumplices)

    # pergunta de treino: não vale ponto
    if training:
        page.wait_for_selector('text=Pergunta de treino')
        mark_all(page, {n: 0 for n in names})
        page.click('button[data-a="revelar"]')
        page.wait_for_selector('.verdict .stamp')
        assert 'treino' in page.inner_text('.verdict').lower()
        assert page.locator('text=Na pergunta de treino ninguém acusa').count() == 1
        page.click('text=Próxima pergunta')

    # rodada 1: IGUAL
    page.wait_for_selector('.entry-row')
    plan = {n: (1 if n in cumplices else (i % 3)) for i, n in enumerate(names)}
    mark_all(page, plan)
    shot(page, f'{prefix}22-um-marcar-votos')
    page.click('button[data-a="revelar"]')
    page.wait_for_selector('.verdict .stamp')
    assert page.text_content('.verdict .stamp').strip().lower() == 'igual'
    shot(page, f'{prefix}23-um-revelacao')

    # acusação aprovada pela mesa, errada
    page.click('text=A mesa aprovou uma acusação')
    page.click(f'button.pick:has-text("{dets[0]}")')
    page.click(f'button.pick:has-text("{dets[1]}")')
    shot(page, f'{prefix}24-um-acusacao')
    page.click('button[data-a="acusar-local"]')
    page.wait_for_selector('.sheet .stamp')
    assert 'inocentes' in page.text_content('.sheet .stamp').lower()
    page.click('text=Continuar')
    assert page.locator('.gamebar .dots i.on').count() == 2

    # rever papel no meio do jogo
    page.click('text=Rever papel')
    page.click(f'button.pick:has-text("{dets[2]}")')
    page.click(f'text=Sou {dets[2]}')
    assert 'detetive' in hold(page).lower()
    release(page)
    page.click('text=Escondi. Voltar para o jogo')

    # recarregar a página no meio: a partida continua
    if can_reload:
        page.reload()
        page.wait_for_selector('text=Continuar')
        page.click('button[data-a="retomar-mesa"]')
    page.wait_for_selector('.entry-row')
    assert page.locator('.gamebar .dots i.on').count() == 2

    # rodadas seguintes: IGUAL até a meta
    meta = 4 if len(names) >= 7 else 3
    while page.locator('.gamebar .dots i.on').count() < meta:
        mark_all(page, {n: (2 if n in cumplices else 0) for n in names})
        page.click('button[data-a="revelar"]')
        page.wait_for_selector('.verdict .stamp, .pair-reveal')
        if page.locator('.pair-reveal').count():
            break
        page.click('text=Próxima pergunta')
        page.wait_for_selector('.entry-row')
    page.wait_for_selector('.pair-reveal')
    txt = page.inner_text('main').lower()
    assert 'cúmplices venceram' in txt, txt[:200]
    assert a.lower() in page.inner_text('.pair-reveal').lower()
    shot(page, f'{prefix}25-um-fim')
    # placar: cada cúmplice 2 pontos
    pts = page.evaluate("() => Object.fromEntries([...document.querySelectorAll('.score li')].map(li => [li.children[0].textContent, +li.children[1].textContent]))")
    assert pts[a] == 2 and pts[b] == 2 and pts[dets[0]] == 0, pts
    page.click('button[data-a="local-de-novo"]')
    page.wait_for_selector(f'text=Sou {names[0]}')
    log(prefix, 'modo um celular ok')


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(SITE)
        run_local(page, ['Vó Lúcia', 'Tio Beto', 'Marina', 'João Pedro', 'Ana', 'Caio', 'Bia'], '')

        # Versão para o Claude: o arquivo vira o corpo de uma página (o Claude acrescenta o resto).
        frag = open(ARTIFACT, encoding='utf-8').read()
        wrapped = ('<!doctype html><html><head><meta charset="utf-8">'
                   '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
                   '<style>body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style></head><body>'
                   + frag + '</body></html>')
        ctx2 = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, color_scheme='dark')
        pg2 = ctx2.new_page()
        pg2.on('pageerror', lambda e: errors.append(str(e)))
        pg2.set_content(wrapped)
        pg2.wait_for_selector('text=Jogar com um celular só')
        assert pg2.locator('text=Criar sala').count() == 0, 'versão do Claude não deveria ter modo online'
        shot(pg2, '30-claude-inicio-escuro')
        run_local(pg2, ['Ana', 'Bia', 'Caio', 'Duda', 'Edu'], 'claude-', training=False, can_reload=False)
        browser.close()
    if errors:
        log('ERROS:', errors[:10])
        sys.exit(1)
    log('E2E LOCAL OK')


if __name__ == '__main__':
    main()
