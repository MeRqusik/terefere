# terefere

Giełda walut (spot i z dźwignią) z kursami na żywo z [London Strategic Edge](https://londonstrategicedge.com/data) i wbudowaną symulacją rynku.

- **Kupno i sprzedaż** 16 par walutowych (EUR/PLN, USD/PLN, GBP/PLN, EUR/USD…) zleceniami rynkowymi, limit i stop. Prowizja 0,1%, realizacja po bid/ask. Konto startuje ze 100 000 PLN, środki pod otwarte zlecenia są blokowane.
- **Dźwignia 1–100×**: pozycje long i short na każdej parze, depozyt i wynik zawsze w PLN. Prowizja 0,01% za stronę. Pozycja zamyka się automatycznie, gdy strata sięgnie 50% depozytu (jak przy regule ESMA), i nigdy nie kosztuje więcej niż depozyt. Wejście i cena likwidacji są rysowane na wykresie.
- **Na żywo**: ticki z WebSocketu LSE, historia świec (1D/7D/1M/3M/1Y) z eksportu CSV LSE.
- **Szybkość**: serwer trzyma świece w pamięci i w `data/candles.json`, dopisuje do nich ticki na żywo i dociąga brakujące serie w tle (nie częściej niż raz na sekundę, żeby zmieścić się w limicie 60 zapytań na minutę). Po pierwszym uruchomieniu wykresy ładują się natychmiast, także po restarcie. Odpowiedzi są kompresowane gzipem, a pliki statyczne mają ETag.
- **Symulacja**: każda waluta ma wartość w USD, która porusza się błądzeniem losowym ze zmiennością policzoną z prawdziwych świec dziennych, ze wspólnym czynnikiem dolara i rzadkimi skokami „newsowymi”. Wszystkie pary są liczone z tych wartości, więc kursy krzyżowe zawsze się zgadzają. Zmienność 1×, 3× lub 10×, spread rośnie razem z nią.
- Arkusz zleceń (zakładka „Głębokość”) jest symulowany wokół bieżącego bid/ask, bo darmowy plan LSE nie daje głębokości rynku dla forex.

## Uruchomienie

Wymaga Node 22+.

```bash
npm install
cp .env.example .env   # wpisz LSE_API_KEY
npm start              # http://localhost:3000
npm test
```

Stan konta zapisuje się w `data/account.json`, a cache świec w `data/candles.json`. Darmowy klucz LSE pozwala na jedno połączenie WebSocket, więc uruchamiaj jedną instancję serwera naraz.
