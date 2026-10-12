"""Modo um celular só, do começo ao fim, no navegador (7 jogadores: meta 3 em até 4 perguntas)."""
import os
import sys

from playwright.sync_api import sync_playwright

SITE = os.environ.get('SITE', 'http://127.0.0.1:8080/')
SHOTS = os.environ.get('SHOTS', '/tmp/claude-0/shots')
os.makedirs(SHOTS, exist_ok=True)
errors = []


def log(*a):
    print(*a, flush=True)


def no_overflow(page, where):
    w = page.evaluate('() => [document.documentElement.scrollWidth, window.innerWidth]')
    assert w[0] <= w[1], f'rolagem lateral em {where}: {w}'


def shot(page, name):
    no_overflow(page, name)
    page.wait_for_timeout(500)
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


def dots(page):
    return page.locator('.gamebar .dots i.on').count()


def run_local(page, names):
    page.click('text=Jogar com um celular só')
    page.wait_for_selector('text=Quem vai jogar')
    while page.locator('input[data-local-name]').count() < len(names):
        page.click('text=+ Adicionar jogador')
    for i, nm in enumerate(names):
        page.fill(f'#nome-{i}', nm)
    page.check('#um-treino')
    assert '3 IGUAIS em até 4 perguntas' in page.inner_text('#um-meta')
    shot(page, '20-um-config')
    page.click('text=Sortear papéis')
    roles = {}
    for i, nm in enumerate(names):
        page.wait_for_selector(f'text=Sou {nm}')
        if i == 0:
            shot(page, '21-um-passar')
        page.click(f'text=Sou {nm}')
        roles[nm] = hold(page)
        release(page)
        page.click('button[data-a="passar"]')
    cumplices = [n for n in names if 'sua dupla' in roles[n].lower()]
    assert len(cumplices) == 2, roles
    a, b = cumplices
    assert b in roles[a] and a in roles[b]
    dets = [n for n in names if n not in cumplices]
    log('cúmplices:', cumplices)

    # pergunta de treino: não vale ponto e ninguém acusa
    page.wait_for_selector('text=Pergunta de treino')
    mark_all(page, {n: 0 for n in names})
    page.click('button[data-a="revelar"]')
    page.wait_for_selector('.verdict .stamp')
    assert 'treino' in page.inner_text('.verdict').lower()
    assert page.locator('text=Na pergunta de treino ninguém acusa').count() == 1
    page.click('text=Próxima pergunta')

    # pergunta 1: IGUAL; ninguém acusa na primeira
    page.wait_for_selector('.entry-row')
    mark_all(page, {n: (1 if n in cumplices else (i % 3)) for i, n in enumerate(names)})
    shot(page, '22-um-marcar-votos')
    page.click('button[data-a="revelar"]')
    page.wait_for_selector('.verdict .stamp')
    assert page.text_content('.verdict .stamp').strip().lower() == 'igual'
    assert page.locator('text=A mesa aprovou uma acusação').count() == 0
    assert page.locator('text=Na primeira pergunta ninguém acusa').count() == 1
    shot(page, '23-um-revelacao')
    page.click('text=Próxima pergunta')

    # pergunta 2: DIFERENTE; acusação aprovada pela mesa, errada → 2 pontos
    page.wait_for_selector('.entry-row')
    plan = {n: 0 for n in names}
    plan[a], plan[b] = 0, 2
    mark_all(page, plan)
    page.click('button[data-a="revelar"]')
    page.wait_for_selector('.verdict .stamp')
    assert page.text_content('.verdict .stamp').strip().lower() == 'diferente'
    page.click('text=A mesa aprovou uma acusação')
    page.click(f'button.pick:has-text("{dets[0]}")')
    page.click(f'button.pick:has-text("{dets[1]}")')
    shot(page, '24-um-acusacao')
    page.click('button[data-a="acusar-local"]')
    page.wait_for_selector('.sheet .stamp')
    assert 'inocentes' in page.text_content('.sheet .stamp').lower()
    page.click('text=Continuar')
    assert dots(page) == 2

    # rever papel no meio do jogo
    page.click('text=Rever papel')
    page.click(f'button.pick:has-text("{dets[2]}")')
    page.click(f'text=Sou {dets[2]}')
    assert 'detetive' in hold(page).lower()
    release(page)
    page.click('text=Escondi. Voltar para o jogo')

    # recarregar a página no meio: a partida continua
    page.reload()
    page.wait_for_selector('text=Continuar')
    page.click('button[data-a="retomar-mesa"]')
    page.wait_for_selector('.entry-row')
    assert dots(page) == 2

    # trocar a pergunta: vem outra e as marcações somem
    before = page.inner_text('h2.question')
    page.click(f'.entry-row:has(.nm:text-is("{names[0]}")) button.vb[data-opt="1"]')
    page.click('button[data-a="trocar-pergunta-local"]')
    page.click('button[data-a="confirm-sim"]')
    page.wait_for_function(f"() => document.querySelector('h2.question').innerText !== {before!r}")
    assert page.locator('button.vb[aria-pressed="true"]').count() == 0

    # pergunta 3: IGUAL → 3 pontos → cúmplices vencem
    mark_all(page, {n: (2 if n in cumplices else 0) for n in names})
    page.click('button[data-a="revelar"]')
    page.wait_for_selector('.pair-reveal')
    txt = page.inner_text('main').lower()
    assert 'cúmplices venceram' in txt, txt[:200]
    assert a.lower() in page.inner_text('.pair-reveal').lower()
    shot(page, '25-um-fim')
    pts = page.evaluate("() => Object.fromEntries([...document.querySelectorAll('.score li')].map(li => [li.children[0].textContent, +li.children[1].textContent]))")
    assert pts[a] == 2 and pts[b] == 2 and pts[dets[0]] == 0, pts
    page.click('button[data-a="local-de-novo"]')
    page.wait_for_selector(f'text=Sou {names[0]}')
    log('modo um celular ok')


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(SITE)
        run_local(page, ['Vó Lúcia', 'Tio Beto', 'Marina', 'João Pedro', 'Ana', 'Caio', 'Bia'])
        browser.close()
    if errors:
        log('ERROS:', errors[:10])
        sys.exit(1)
    log('E2E LOCAL OK')


if __name__ == '__main__':
    main()
