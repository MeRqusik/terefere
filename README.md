# terefere

Giełda walut (spot) z kursami na żywo z [London Strategic Edge](https://londonstrategicedge.com/data) i wbudowaną symulacją rynku.

- **Kupno i sprzedaż** 16 par walutowych (EUR/PLN, USD/PLN, GBP/PLN, EUR/USD…) zleceniami rynkowymi, limit i stop. Prowizja 0,1%, realizacja po bid/ask. Konto startuje ze 100 000 PLN, środki pod otwarte zlecenia są blokowane.
- **Na żywo**: ticki z WebSocketu LSE, historia świec (1D/7D/1M/3M/1Y) z eksportu CSV LSE.
- **Symulacja**: każda waluta ma wartość w USD, która porusza się błądzeniem losowym ze zmiennością policzoną z prawdziwych świec godzinowych, ze wspólnym czynnikiem dolara i rzadkimi skokami „newsowymi”. Wszystkie pary są liczone z tych wartości, więc kursy krzyżowe zawsze się zgadzają. Zmienność 1×, 3× lub 10×, spread rośnie razem z nią.
- Arkusz zleceń (zakładka „Głębokość”) jest symulowany wokół bieżącego bid/ask, bo darmowy plan LSE nie daje głębokości rynku dla forex.

## Uruchomienie

Wymaga Node 22+.

```bash
npm install
cp .env.example .env   # wpisz LSE_API_KEY
npm start              # http://localhost:3000
npm test
```

Stan konta zapisuje się w `data/account.json`. Darmowy klucz LSE pozwala na jedno połączenie WebSocket, więc uruchamiaj jedną instancję serwera naraz.
